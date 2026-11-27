import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { createWriteStream, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const mode=process.argv[2];
let seq=0;
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
const emit=(type,data)=>send({jsonrpc:'2.0',method:'event',params:{seq:++seq,ts:new Date().toISOString(),type,data}});
const usage={input_tokens:null,output_tokens:null,cache_read_tokens:null,cache_write_tokens:null,steps:1,turns:1,completeness:'exact',extra:{},native_cost_usd:null,basis:{native_scope:'segment',aggregation:'cumulative',cache_in_input:null,source:'fixture'},native_cumulative:null};
let started=false;
const finish=(outcome='completed')=>emit('run.finished',{outcome,error:null,work_started:true,final_message:'ok',usage,steps:1,turns:1,resume_token:null,model:{},reasoning_effort:{},native_session_id:null,native_exit:{code:0,signal:null}});
createInterface({input:process.stdin}).on('line',line=>{
 const req=JSON.parse(line);
 if(req.method==='initialize')send({jsonrpc:'2.0',id:req.id,result:{protocol_version:'0.2'}});
 if(req.method==='capabilities'){
   if(mode==='capabilities-error')send({jsonrpc:'2.0',id:req.id,error:{code:-32003,message:'capabilities requires a control session'}});
   else send({jsonrpc:'2.0',id:req.id,result:{features:{cancel:{control_message:mode.startsWith('control'),grace_s:1}}}});
 }
 if(req.method==='run.complete'&&mode==='complete-hang')send({jsonrpc:'2.0',id:req.id,result:{accepted:true}});
 if(req.method==='run.cancel'&&mode.startsWith('control')){
   writeFileSync('cancel.json',JSON.stringify({params:req.params,at:Date.now()}));send({jsonrpc:'2.0',id:req.id,result:{accepted:true}});if(mode==='control')finish('cancelled');
 }
 if(req.method==='run.start'){
   started=true;send({jsonrpc:'2.0',id:req.id,result:{accepted:true}});emit('session.started',{native_session_id:null,native_version:null,model:null,reasoning_effort:{}});
   if(mode==='orphan'||mode==='crash-orphan'){
     spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setTimeout(()=>{},30000)"],{stdio:'ignore',env:{}});
   }
   if(mode==='crash-orphan'){setTimeout(()=>process.exit(2),40);return;}
   if(mode==='late-orphan'){
     spawn(process.execPath,[fileURLToPath(new URL('./late-descendant.mjs',import.meta.url))],{stdio:'ignore',env:{}});
     finish();setTimeout(()=>process.exit(0),20);return;
   }
   if(mode==='complete-hang'){emit('input.requested',{prompt:'next'});return;}
   if(mode==='capabilities-error')return;
   if(mode.startsWith('control')||mode==='no-control')return;
   if(mode==='stderr-large'||mode==='raw-large'){
     const stream=mode==='stderr-large'?process.stderr:createWriteStream(null,{fd:3,autoClose:false});
     stream.write('x'.repeat(1_200_000),()=>{stream.write('\n');emit('message',{text:'after large log'});finish();});return;
   }
   if(mode==='stdout-large'){process.stdout.write('x'.repeat(1_200_000));return;}
   finish();
   if(mode==='orphan')setTimeout(()=>process.exit(0),20);
   if(mode==='trailing'){emit('message',{text:'illegal trailing message'});}
 }
}).on('close',()=>{if(mode!=='linger'&&mode!=='trailing')process.exit(0);});
process.on('SIGTERM',()=>{
  if(mode==='control')writeFileSync('term.json','unexpected');
  if(mode==='capabilities-error')writeFileSync('term.json','received');
});
setTimeout(()=>process.exit(started?0:1),30000);
