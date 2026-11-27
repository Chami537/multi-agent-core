import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Runtime } from '../dist/core/runtime.js';
import { move } from '../dist/core/lifecycle.js';
import { alive, identity, jsonFile, signalProcess } from '../dist/host/process.js';
import { allocations, cleanup, launchFixture, makeRuntime, markerPreserver, prompt, state, until, workspace } from './helpers/runtime.js';

afterEach(cleanup);
describe('real shim + fake runner',()=>{
 it('normal completion commits only after physical exit and preservation',async()=>{
   const rt=makeRuntime(),r=rt.create({workspace:workspace(rt)});rt.start(r.id);const done=await state(rt,r.id,'done');expect(done.preservation.state).toBe('saved');expect(existsSync(join(r.runDir,'final-marker.json'))).toBe(true);expect(rt.host.facts(r.runDir,1).groupAlive).toBe(false);expect(done.reservation).toBe(false);
 });
 it('stdin waiting holds capacity, input is idempotent, and stays in one segment',async()=>{
   const rt=makeRuntime(),r=rt.create({workspace:workspace(rt),inputMode:'stdin',prompt:prompt('interactive:1')});rt.start(r.id);expect((await state(rt,r.id,'waiting')).reservation).toBe(true);
   const other=rt.create({workspace:workspace(rt)});expect(()=>rt.start(other.id)).toThrow('capacity');rt.message(r.id,'input-1','go');rt.message(r.id,'input-1','go');expect(()=>rt.message(r.id,'input-1','different')).toThrow('input_conflict');rt.start(r.id);
   expect((await state(rt,r.id,'done')).segment).toBe(1);rt.start(other.id);await state(rt,other.id,'done');
 });
 it('durable input outbox survives a crash between state commit and shim delivery',async()=>{
   const rt=makeRuntime(),r=rt.create({workspace:workspace(rt),inputMode:'stdin',prompt:prompt('interactive:1')});rt.start(r.id);await state(rt,r.id,'waiting');rt.message(r.id,'durable','go');
   const command=rt.host.command.bind(rt.host);rt.host.command=()=>{throw new Error('delivery crash');};expect(()=>rt.start(r.id)).toThrow('delivery crash');rt.host.command=command;
   expect(rt.store.get(r.id).state).toBe('running');expect(rt.store.get(r.id).messages[0]?.state).toBe('dispatching');rt.close();
   const next=new Runtime({root:rt.root,preserve:markerPreserver,timing:{exitMs:120,killMs:70,graceMs:70}});allocations.push({root:rt.root,runtime:next});await next.recover();expect((await state(next,r.id,'done')).messages[0]?.state).toBe('delivered');
 });
 it('stdin complete closes a resident endpoint',async()=>{
   const rt=makeRuntime(),r=rt.create({workspace:workspace(rt),inputMode:'stdin',prompt:prompt('interactive:2')});rt.start(r.id);const waiting=await state(rt,r.id,'waiting');rt.complete(r.id);
   expect(rt.store.get(r.id).finalizing).toBe(true);expect(rt.store.get(r.id).version).toBe(waiting.version+1);
   expect(()=>rt.message(r.id,'too-late','go')).toThrow('invalid_message_state');expect(()=>rt.complete(r.id)).toThrow('invalid_complete_state');
   const done=await state(rt,r.id,'done');expect(done.segment).toBe(1);expect(done.messages.filter(m=>m.state==='pending')).toHaveLength(0);
 });
 it('resume waiting releases capacity and next input starts a new fenced segment',async()=>{
   const rt=makeRuntime(),r=rt.create({workspace:workspace(rt),inputMode:'resume',prompt:prompt('interactive:1')});rt.start(r.id);const waiting=await state(rt,r.id,'waiting');expect(waiting.reservation).toBe(false);expect(waiting.resumeToken).toBeTypeOf('string');
   const other=rt.create({workspace:workspace(rt),prompt:prompt('ok_slow:0.2')});rt.start(other.id);rt.message(r.id,'input-1','go');expect(()=>rt.start(r.id)).toThrow('capacity');await state(rt,other.id,'done');rt.start(r.id);const done=await state(rt,r.id,'done');expect(done.segment).toBe(2);expect(done.previousSteps).toBe(1);
 });
 it('resume complete finalizes without launching another process',async()=>{
   const rt=makeRuntime(),r=rt.create({workspace:workspace(rt),inputMode:'resume',prompt:prompt('interactive:1')});rt.start(r.id);await state(rt,r.id,'waiting');rt.complete(r.id);expect((await state(rt,r.id,'done')).segment).toBe(1);
 });
 it('deterministic failure returns failed',async()=>{
   const rt=makeRuntime(),r=rt.create({workspace:workspace(rt),prompt:prompt('fail')});rt.start(r.id);expect((await state(rt,r.id,'failed')).reason).toBe('task_failed');
 });
 it('max_steps counts model step operations, never individual tools',async()=>{
   const rt=makeRuntime(),r=rt.create({workspace:workspace(rt),fakeMaxSteps:2,prompt:prompt({schema:'mac.fake-scenario/0.2',steps:[{op:'step'},{op:'tool',tool:'shell'},{op:'tool',tool:'shell'},{op:'step'},{op:'tool',tool:'shell'},{op:'step'},{op:'complete'}]})});rt.start(r.id);
   const paused=await state(rt,r.id,'paused');expect(paused.reason).toBe('step_limit_reached');expect(paused.usage.steps).toBe(2);
   expect(rt.store.db.prepare("SELECT COUNT(*) n FROM activity WHERE run_id=? AND json_extract(payload,'$.type')='tool.call'").get(r.id)?.n).toBe(3);
 });
 it('script without step is one model invocation',async()=>{
   const rt=makeRuntime(),r=rt.create({workspace:workspace(rt),fakeMaxSteps:1});rt.start(r.id);expect((await state(rt,r.id,'done')).usage.steps).toBe(1);
 });
 it('stop uses the declared control message even when the fake ignores SIGTERM',async()=>{
   const rt=makeRuntime(),r=rt.create({workspace:workspace(rt),prompt:prompt('ignore_term')});rt.start(r.id);
   await until(async()=>{await rt.tick();return rt.store.get(r.id).usage.steps===1;}); await new Promise(res=>setTimeout(res,80));rt.stop(r.id);expect((await state(rt,r.id,'cancelled')).reason).toBe('supervisor_cancel');expect(rt.host.facts(r.runDir,1).groupAlive).toBe(false);
 });
 it('finished but live endpoint waits exit deadline, then TERM and KILL; outcome becomes protocol violation',async()=>{
   const rt=makeRuntime({timing:{exitMs:300,killMs:80,graceMs:50}}),r=launchFixture(rt,'linger');
   await until(async()=>{await rt.tick();return !!rt.store.get(r.id).candidate;});const at=rt.store.get(r.id).candidate!.at;expect(rt.store.get(r.id).cleanupTermAt).toBeNull();
   await rt.tick(at+299);expect(rt.store.get(r.id).cleanupTermAt).toBeNull();await rt.tick(at+300);expect(rt.store.get(r.id).cleanupTermAt).toBe(at+300);await rt.tick(at+380);
   const failed=await state(rt,r.id,'failed');expect(failed.reason).toBe('protocol_violation');expect(rt.host.facts(r.runDir,1).groupAlive).toBe(false);
 });
 it('endpoint exited with orphan descendants is evicted immediately, before exit deadline',async()=>{
   const rt=makeRuntime({timing:{exitMs:10000,killMs:80,graceMs:50}}),r=launchFixture(rt,'orphan');
   await until(async()=>{await rt.tick();return rt.store.get(r.id).cleanupTermAt!==null;});const result=rt.store.get(r.id);expect(result.cleanupTermAt!-result.candidate!.at).toBeLessThan(10000);expect(rt.host.facts(r.runDir,1).endpointAlive).toBe(false);
   const failed=await state(rt,r.id,'failed');expect(failed.reason).toBe('protocol_violation');expect(rt.host.facts(r.runDir,1).groupAlive).toBe(false);
 });
 it('trailing output after finished changes successful candidate into failed',async()=>{
   const rt=makeRuntime(),r=launchFixture(rt,'trailing');expect((await state(rt,r.id,'failed')).reason).toBe('protocol_violation');
 });
 it('SIGKILL of a real daemon leaves shim and endpoint alive and another daemon reattaches',async()=>{
   const root=mkdtempSync(join(tmpdir(),'mac-daemon-')),ws=join(root,'workspace');mkdirSync(ws);
   const daemon=spawn(process.execPath,[resolve('tests/helpers/daemon.mjs'),root,ws],{stdio:'ignore'}),daemonIdentity=identity(daemon.pid!);let rt:Runtime|undefined;
   try{
     await until(()=>existsSync(join(root,'ready.json')));const info=jsonFile<{runId:string;shim:{pid:number;start:string;boot:string};endpoint:{pid:number;start:string;boot:string}}>(join(root,'ready.json'))!;
     signalProcess(daemonIdentity,'SIGKILL');await new Promise<void>(resolve=>daemon.once('close',()=>resolve()));expect(alive(info.shim)).toBe(true);expect(alive(info.endpoint)).toBe(true);
     rt=new Runtime({root,preserve:markerPreserver,timing:{exitMs:120,killMs:70,graceMs:70}});allocations.push({root,runtime:rt});await rt.recover();expect(rt.store.get(info.runId).state).toBe('running');expect(rt.host.facts(rt.store.get(info.runId).runDir,1).endpointAlive).toBe(true);
     rt.stop(info.runId);await state(rt,info.runId,'cancelled');
   }finally{if(daemon.exitCode===null&&daemon.signalCode===null)signalProcess(daemonIdentity,'SIGKILL');}
 });
 it('instance flock forbids concurrent executors and epoch increments after detach',()=>{
   const rt=makeRuntime();expect(()=>new Runtime({root:rt.root,preserve:markerPreserver})).toThrow('instance_locked');const epoch=rt.epoch;rt.close();const next=new Runtime({root:rt.root,preserve:markerPreserver});allocations.push({root:rt.root,runtime:next});expect(next.epoch).toBe(epoch+1);
 });
 it('missing startup directory is fenced void and retries use a fresh segment number',async()=>{
   const rt=makeRuntime(),r=rt.create({workspace:workspace(rt)});r.segment=1;r.intent={runId:r.id,segment:1,segmentKind:'initial',launchToken:randomUUID(),daemonEpoch:rt.epoch,status:'pending'};rt.store.transaction(()=>{move(r,'running',null);rt.store.put(r);});
   await rt.recover();expect(rt.store.get(r.id).state).toBe('queued');expect(rt.store.get(r.id).launchAttempts).toBe(1);expect(rt.host.isVoid(r.runDir,1)).toBe(true);rt.start(r.id);expect((await state(rt,r.id,'done')).segment).toBe(2);
 });
 it('unconfirmed existing segment is uncertain execution, never launched again',async()=>{
   const rt=makeRuntime(),r=rt.create({workspace:workspace(rt)});r.segment=1;r.intent={runId:r.id,segment:1,segmentKind:'initial',launchToken:randomUUID(),daemonEpoch:rt.epoch,status:'pending'};rt.store.transaction(()=>{move(r,'running',null);rt.store.put(r);});mkdirSync(join(r.runDir,'segments','1'),{recursive:true});
   await rt.recover();expect(rt.store.get(r.id).state).toBe('interrupted');expect(rt.store.get(r.id).reason).toBe('recovery_failed');expect(rt.store.get(r.id).preservation.kind).toBe('wip');
 });
 it.each(['depends_on','fallbacks','priority','budget','review_of','target_branch'])('rejects future field %s before resource creation',field=>{
   const rt=makeRuntime();expect(()=>rt.create({workspace:workspace(rt),[field]:{}})).toThrow('not_implemented');expect(rt.store.list()).toHaveLength(0);
 });
 it.each([{fakeMaxSteps:-1},{account:'../outside'},{inputMode:'invalid'},{prompt:'x'.repeat(900*1024+1)}])('rejects invalid core input before reservation',options=>{
   const rt=makeRuntime();expect(()=>rt.create({workspace:workspace(rt),...options} as never)).toThrow();expect(rt.store.list()).toHaveLength(0);
 });
 it('rejects Phase 4 role values instead of accepting them silently',()=>{const rt=makeRuntime();expect(()=>rt.create({workspace:workspace(rt),role:'review'})).toThrow('not_implemented');expect(rt.store.list()).toHaveLength(0);});
});
