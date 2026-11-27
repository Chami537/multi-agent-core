import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { emptyUsage, type Finished } from '../dist/core/types.js';
import { noWorkProduced } from '../dist/core/launch.js';
import { cleanup, makeRuntime, prompt, state, workspace } from './helpers/runtime.js';
const failed:Finished={outcome:'failed',error:{code:'auth_failed'},work_started:false,usage:emptyUsage(),steps:null,turns:null,final_message:null,resume_token:null,native_session_id:null,native_exit:null,model:{},reasoning_effort:{}};
afterEach(cleanup);
describe('T8 requires positive no-work proof',()=>{
 it.each([
  [false,true,true,true],[false,null,true,false],[false,true,null,false],[true,true,true,false],[false,false,true,false],
 ] as const)('tool/file=%s, HEAD unchanged=%s, clean=%s -> retry=%s',(toolOrFileEvent,headUnchanged,clean,expected)=>{
  expect(noWorkProduced(failed,{toolOrFileEvent,headUnchanged,clean})).toBe(expected);
 });
 it('runner work_started=true always forbids retry',()=>expect(noWorkProduced({...failed,work_started:true},{toolOrFileEvent:false,headUnchanged:true,clean:true})).toBe(false));
 it('clean Git proof permits three fresh retries, then the fourth attempt fails',async()=>{
  const rt=makeRuntime(),cwd=workspace(rt);
  for(const args of [['init','-q'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','fixture']]){
   const result=spawnSync('/usr/bin/git',args,{cwd,env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},timeout:2000});expect(result.status).toBe(0);
  }
  const r=rt.create({workspace:cwd,prompt:prompt({schema:'mac.fake-scenario/0.2',steps:[{op:'fail',error:{code:'auth_failed'},work_started:false}]})});
  for(let n=1;n<=4;n++){
   rt.start(r.id);const result=await state(rt,r.id,n===4?'failed':'queued');expect(result.segment).toBe(n);expect(result.launchAttempts).toBe(Math.min(n,3));
  }
  expect(rt.store.get(r.id).reason).toBe('launch_failed');
 });
 it('unknown workspace proof conservatively interrupts and preserves WIP',async()=>{
  const rt=makeRuntime(),r=rt.create({workspace:workspace(rt),prompt:prompt({schema:'mac.fake-scenario/0.2',steps:[{op:'fail',error:{code:'auth_failed'},work_started:false}]})});rt.start(r.id);const result=await state(rt,r.id,'interrupted');expect(result.reason).toBe('auth_failed');expect(result.preservation.kind).toBe('wip');
 });
});
