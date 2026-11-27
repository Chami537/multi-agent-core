import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { until } from './helpers/runtime.js';
const children: ChildProcessWithoutNullStreams[]=[];
function endpoint() {
  const child=spawn(process.execPath,[resolve('dist/runners/fake.js')],{env:{MAC_SESSION_KIND:'control'}});children.push(child);
  let next=0;const replies=new Map<number,Record<string,any>>();const events:Record<string,any>[]=[];
  createInterface({input:child.stdout}).on('line',line=>{const f=JSON.parse(line);if(f.id!==undefined)replies.set(f.id,f);else events.push(f);});
  return {child,events,async rpc(method:string,params:unknown={}) {const id=++next;child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');await until(()=>replies.has(id));return replies.get(id)!;}};
}
const init={protocol_versions:['0.2'],host:{name:'test',version:'0.1.0',instance_id:'test'},session_kind:'control',conformance:false};
const start={run_id:'test',segment:1,prompt:{text:'```mac-fake\ninteractive:2\n```',format:'markdown'},model:{id:'fake-high'},reasoning_effort:{effort:'default',native:null},interaction:'interactive',workspace:{cwd:process.cwd(),read_only:false,artifacts_dir:process.cwd(),scratch_dir:process.cwd(),readonly_paths:[]},limits:{max_steps:null,total_s:null,idle_s:null},forbidden:[],resume:null,raw_dir:null,conformance:null};
afterEach(async()=>{for(const child of children){if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await new Promise<void>(r=>child.once('close',()=>r()));}}children.length=0;});
describe('fake endpoint protocol subset',()=>{
 it('requires initialize, negotiates 0.2 and exposes consistent capabilities',async()=>{
  const e=endpoint();expect((await e.rpc('capabilities')).error.code).toBe(-32002);expect((await e.rpc('initialize',init)).result.protocol_version).toBe('0.2');
  const caps=(await e.rpc('capabilities')).result;expect(caps.runner.id).toBe('fake');expect(caps.features.interaction.holds_slot_while_waiting).toBe(true);expect(caps.models[0].efforts).toContainEqual({effort:'high',native:'h'});expect(caps.features.read_only.enforceable).toBe(false);
  const probe=(await e.rpc('probe',{level:'auth'})).result;expect(probe.billable).toBe(false);expect(probe.components[0].id).toBe('auth');
 });
 it('rejects incompatible versions with exit code 64',async()=>{
  const e=endpoint();const done=new Promise<number|null>(r=>e.child.once('exit',r));const reply=await e.rpc('initialize',{...init,protocol_versions:['9.9']});expect(reply.error.code).toBe(-32001);expect(reply.error.data.supported).toEqual(['0.2']);expect(await done).toBe(64);
 });
 it('validates the protocol wrapper and rejects safety capability requests before starting',async()=>{
  const e=endpoint();await e.rpc('initialize',init);
  expect((await e.rpc('validate',{start})).result.ok).toBe(true);
  const readonly={...start,workspace:{...start.workspace,read_only:true}};
  expect((await e.rpc('validate',{start:readonly})).result).toMatchObject({ok:false,violations:[{rule:'READ_ONLY_UNSUPPORTED'}]});
  expect((await e.rpc('run.start',readonly)).error.code).toBe(-32005);expect(e.events).toHaveLength(0);
 });
 it('unknown command fields include diagnostics and do not start work',async()=>{
  const e=endpoint();await e.rpc('initialize',init);const reply=await e.rpc('run.start',{...start,surprise:true});expect(reply.error.code).toBe(-32602);expect(reply.error.data.unknown_fields).toEqual(['surprise']);expect(e.events).toHaveLength(0);
 });
 it('accepts only one start and deduplicates input IDs without repeating effects',async()=>{
  const e=endpoint();await e.rpc('initialize',init);await e.rpc('run.start',start);await until(()=>e.events.some(f=>f.params.type==='input.requested'));
  expect((await e.rpc('run.start',start)).error.code).toBe(-32003);
  expect((await e.rpc('run.input',{input_id:'input',text:'go'})).result.duplicate).toBe(false);
  expect((await e.rpc('run.input',{input_id:'input',text:'go'})).result.duplicate).toBe(true);
  expect((await e.rpc('run.input',{input_id:'input',text:'changed'})).error.code).toBe(-32007);
  expect(e.events.filter(f=>f.params.type==='input.requested')).toHaveLength(2);await e.rpc('run.complete',{});await until(()=>e.events.some(f=>f.params.type==='run.finished'));e.child.stdin.end();
  const seq=e.events.map(f=>f.params.seq);expect(seq).toEqual(seq.map((_,i)=>i+1));expect(e.events.at(-1)?.params.type).toBe('run.finished');
 });
});
