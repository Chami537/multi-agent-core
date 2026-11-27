import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyUsage } from '../dist/core/types.js';
import { ingest, cursor } from '../dist/store/ingest.js';
import { Store } from '../dist/store/database.js';
import { repairTail } from '../dist/host/logs.js';
import { bootId, tryLock } from '../dist/host/process.js';
import { applyEvent } from '../dist/core/reducer.js';
import { cleanup, makeRuntime, workspace } from './helpers/runtime.js';

function fixture() {
  const runtime=makeRuntime(), r=runtime.create({ workspace:workspace(runtime) }); r.segment=1; r.state='running'; r.reservation=true;
  runtime.store.transaction(()=>runtime.store.put(r));
  const dir=join(r.runDir,'segments','1'); mkdirSync(dir,{recursive:true}); const path=join(dir,'protocol.ndjson'); writeFileSync(path,'');
  return { runtime, store:runtime.store, r, dir, path };
}
function frame(seq:number, type:string, data:unknown={}) { return JSON.stringify({jsonrpc:'2.0',method:'event',params:{seq,ts:new Date(0).toISOString(),type,data}})+'\n'; }
const start=()=>frame(1,'session.started',{native_session_id:null,native_version:null,model:null,reasoning_effort:{}});
const finished=(usage=emptyUsage())=>({outcome:'completed',error:null,work_started:true,usage,final_message:null,model:{},reasoning_effort:{},steps:usage.steps,turns:usage.turns,resume_token:null,native_session_id:null,native_exit:null});
const usage=()=>frame(2,'usage',{...emptyUsage(),input_tokens:10,steps:1});
afterEach(cleanup);
describe('SQLite event transaction and NDJSON recovery',()=>{
  it('enables WAL and applies checksummed migrations once',()=>{
    const {runtime,store}=fixture(); expect(store.db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal'); expect(store.db.prepare('SELECT COUNT(*) n FROM schema_versions').get()?.n).toBe(1);
    const path=join(runtime.root,'state.sqlite'); runtime.close(); const reopened=new Store(path); expect(reopened.db.prepare('SELECT COUNT(*) n FROM schema_versions').get()?.n).toBe(1); reopened.close();
  });
  it('commits UTF-8 byte offset, usage, dedup and global seq together',()=>{
    const {store,r,path}=fixture(); const text=start()+usage()+frame(3,'message',{text:'中文🧪'}); writeFileSync(path,text);
    expect(ingest(store,r.id,path)).toBe(3); expect(cursor(store,r.id,1).offset).toBe(Buffer.byteLength(text)); expect(store.get(r.id).usage.input_tokens).toBe(10);
    const high=store.meta().high; expect(ingest(store,r.id,path)).toBe(0); expect(store.meta().high).toBe(high);
  });
  it('replays rolled-back lines after restart without advancing any derived facts',()=>{
    const {store,r,path}=fixture(); writeFileSync(path,start()+usage()); const high=store.meta().high;
    expect(()=>ingest(store,r.id,path,0,(run,e,now)=>{applyEvent(run,e,now);if(e.type==='usage')throw new Error('injected crash');})).toThrow('injected crash');
    expect(cursor(store,r.id,1).offset).toBe(0); expect(store.get(r.id).usage.input_tokens).toBeNull(); expect(store.meta().high).toBe(high); expect(store.db.prepare('SELECT COUNT(*) n FROM consumed').get()?.n).toBe(0);
    expect(ingest(store,r.id,path)).toBe(2); expect(store.get(r.id).usage.input_tokens).toBe(10);
  });
  it('SQLite failure rolls back instead of being swallowed as a protocol fault',()=>{
    const {store,r,path}=fixture(); writeFileSync(path,start());
    store.db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'disk failure'); END");
    expect(()=>ingest(store,r.id,path)).toThrow('disk failure'); expect(cursor(store,r.id,1).offset).toBe(0); expect(store.get(r.id).protocolViolation).toBeNull();
  });
  it('deduplicates after cursor rewind even after finished, without extra usage/events',()=>{
    const {store,r,path}=fixture(); writeFileSync(path,start()+usage()+frame(3,'run.finished',finished({...emptyUsage(),input_tokens:10,steps:1})));
    ingest(store,r.id,path); const high=store.meta().high;
    store.db.prepare('UPDATE cursors SET byte_offset=0').run(); expect(ingest(store,r.id,path)).toBe(0); expect(store.meta().high).toBe(high); expect(store.get(r.id).protocolViolation).toBeNull();
  });
  it('reads only complete lines while producer is alive',()=>{
    const {store,r,path}=fixture(); writeFileSync(path,start()+usage().slice(0,-4)); expect(ingest(store,r.id,path)).toBe(1); const committed=cursor(store,r.id,1).offset;
    appendFileSync(path,usage().slice(-4)); expect(ingest(store,r.id,path)).toBe(1); expect(cursor(store,r.id,1).offset).toBeGreaterThan(committed);
  });
  it('does not rewind when disk file is shorter than committed offset',()=>{
    const {store,r,path}=fixture(); writeFileSync(path,start()+usage()); ingest(store,r.id,path); const c=cursor(store,r.id,1); truncateSync(path,0);
    expect(ingest(store,r.id,path)).toBe(0); expect(cursor(store,r.id,1)).toEqual(c); expect(store.db.prepare("SELECT kind FROM diagnostics WHERE kind='file_shorter_than_offset'").get()).toBeTruthy();
  });
  it.each(['gap','conflict','duplicate','after_finished','non_json','null_frame'] as const)('detects %s as protocol violation',kind=>{
    const {store,r,path}=fixture();
    let text=start();
    if(kind==='gap')text+=frame(3,'message',{text:'gap'});
    if(kind==='duplicate')text+=start();
    if(kind==='null_frame')text+='null\n';
    if(kind==='conflict') {writeFileSync(path,text);ingest(store,r.id,path);text+=frame(1,'message',{text:'different'});}
    if(kind==='after_finished')text+=frame(2,'run.finished',finished())+frame(3,'message',{text:'late'});
    if(kind==='non_json')text+='bad JSON\n';
    writeFileSync(path,text);ingest(store,r.id,path);expect(store.get(r.id).protocolViolation).toBeTruthy();
  });
  it('repairs a partial tail only after writer lock is free AND producer/group are gone',()=>{
    const {dir,path}=fixture(); const text=start(); writeFileSync(path,text+'partial秘密');
    const producer={shim:{pid:999_999_999,start:'0',boot:bootId()},pgid:null,boot:bootId()};
    const release=tryLock(join(dir,'writer.lock'))!; expect(release).toBeTypeOf('function'); expect(repairTail(dir,producer)).toBeNull(); expect(readFileSync(path,'utf8')).toContain('partial'); release();
    const result=repairTail(dir,producer); expect(result?.removed).toBe(Buffer.byteLength('partial秘密')); expect(result?.digest).toHaveLength(64); expect(readFileSync(path,'utf8')).toBe(text);
  });
  it('global seq and complete_from_seq survive prefix deletion, VACUUM, and reopen',()=>{
    const {runtime,store}=fixture(); store.transaction(()=>{store.db.prepare('UPDATE instance_meta SET high_seq=10').run();store.emit('alert',{},null,0);});
    store.prune(8,Date.now()+15*86_400_000); expect(store.meta().complete).toBe(8); expect(store.db.prepare('SELECT MIN(seq) n FROM events').get()?.n).toBe(11);
    expect(store.eventsSince(6).reset).toBe(true); expect(store.eventsSince(7).reset).toBe(false); store.db.exec('VACUUM'); const dbpath=join(runtime.root,'state.sqlite'); runtime.close();
    const s=new Store(dbpath); const e=s.transaction(()=>s.emit('alert',{})); expect(e.seq).toBe(12); expect(s.meta().complete).toBe(8); s.close();
  });
  it('never prunes a newer event hidden behind an old out-of-order timestamp',()=>{
    const {store}=fixture(); store.transaction(()=>store.emit('alert',{},null,0)); expect(()=>store.prune(store.meta().high+1,Date.now())).toThrow('retention_not_elapsed'); expect(()=>store.prune(1,Date.now(),1)).toThrow('retention_too_short');
  });
});
