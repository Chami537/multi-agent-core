import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.on('SIGTERM',()=>{});
setTimeout(()=>process.exit(0),10_000);
if(process.argv[2]==='grandchild'){
  writeFileSync('late-grandchild.json',JSON.stringify({pid:process.pid}));
}else{
  writeFileSync('late-child.json',JSON.stringify({pid:process.pid}));
  let spawned=false;
  setInterval(()=>{
    if(!spawned&&existsSync('spawn-grandchild')){
      spawned=true;
      spawn(process.execPath,[fileURLToPath(import.meta.url),'grandchild'],{stdio:'ignore',env:{}}).unref();
    }
    if(spawned&&existsSync('late-grandchild.json'))process.exit(0);
  },10);
}
