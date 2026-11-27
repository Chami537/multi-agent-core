import { Runtime } from '../../dist/core/runtime.js';
import { durableJson } from '../../dist/host/process.js';
import { join } from 'node:path';
const [root, workspace] = process.argv.slice(2);
const runtime = new Runtime({ root, preserve: async (_run,kind)=>({state:'saved',kind,sha:null,error:null}) });
const run = runtime.create({ workspace, prompt:'```mac-fake\n{"schema":"mac.fake-scenario/0.2","steps":[{"op":"sleep","ms":30000},{"op":"complete"}]}\n```' });
runtime.start(run.id);
const timer=setInterval(async()=>{
  await runtime.tick(); const facts=runtime.host.facts(run.runDir,1);
  if(facts.endpointAlive && facts.shimAlive)durableJson(join(root,'ready.json'),{runId:run.id,shim:facts.status.shim,endpoint:facts.status.endpoint});
},20);
process.on('SIGTERM',()=>{clearInterval(timer);runtime.close();process.exit(0);});
