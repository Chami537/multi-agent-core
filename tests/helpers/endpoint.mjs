import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
const mode=process.argv[2];
let seq=0;
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
const emit=(type,data)=>send({jsonrpc:'2.0',method:'event',params:{seq:++seq,ts:new Date().toISOString(),type,data}});
const usage={input_tokens:null,output_tokens:null,cache_read_tokens:null,cache_write_tokens:null,steps:1,turns:1,completeness:'exact',extra:{},native_cost_usd:null,basis:{native_scope:'segment',aggregation:'cumulative',cache_in_input:null,source:'fixture'},native_cumulative:null};
let started=false;
createInterface({input:process.stdin}).on('line',line=>{
 const req=JSON.parse(line);
 if(req.method==='initialize')send({jsonrpc:'2.0',id:req.id,result:{protocol_version:'0.2'}});
 if(req.method==='run.start'){
   started=true;send({jsonrpc:'2.0',id:req.id,result:{accepted:true}});emit('session.started',{native_session_id:null,native_version:null,model:null,reasoning_effort:{}});
   if(mode==='orphan'){
     spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setTimeout(()=>{},30000)"],{stdio:'ignore',env:{}});
   }
   emit('run.finished',{outcome:'completed',error:null,work_started:true,final_message:'ok',usage,steps:1,turns:1,resume_token:null,model:{},reasoning_effort:{},native_session_id:null,native_exit:{code:0,signal:null}});
   if(mode==='orphan')setTimeout(()=>process.exit(0),20);
   if(mode==='trailing'){emit('message',{text:'illegal trailing message'});}
 }
}).on('close',()=>{if(mode!=='linger'&&mode!=='trailing')process.exit(0);});
process.on('SIGTERM',()=>{});
setTimeout(()=>process.exit(started?0:1),30000);
