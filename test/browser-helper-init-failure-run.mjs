import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const helper=fileURLToPath(new URL('../tools/browser-control.mjs',import.meta.url));
const profile=path.join(os.tmpdir(),'rc-browser-init-fail-'+process.pid+'-'+Date.now().toString(36));
const child=spawn(process.execPath,[helper,'--server'],{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});
let stderr='';child.stderr.on('data',c=>stderr+=c.toString('utf8'));
const rl=createInterface({input:child.stdout,crlfDelay:Infinity});
const it=rl[Symbol.asyncIterator]();
const next=async()=>{
 const result=await Promise.race([it.next(),new Promise((_,reject)=>setTimeout(()=>reject(Error('HELPER_LINE_TIMEOUT')),12000))]);
 if(result.done)throw Error('HELPER_EOF '+stderr.slice(-500));
 return JSON.parse(result.value);
};
const send=o=>child.stdin.write(JSON.stringify(o)+'\n');
try{
 const ready=await next();if(ready.ok!==true||ready.ready!==true)throw Error('HELPER_NOT_READY');
 send({action:'start',profileDir:profile,isolated:true,executable:process.execPath});const failed=await next();
 if(failed.ok!==false||failed.error!=='BROWSER_EXECUTABLE_NOT_FOUND')throw Error('UNTRUSTED_EXECUTABLE_NOT_REJECTED');
 for(let i=0;i<80&&fs.existsSync(profile);i++)await new Promise(r=>setTimeout(r,50));
 if(fs.existsSync(profile))throw Error('INIT_FAILURE_PROFILE_NOT_REMOVED');
 send({action:'status'});const status=await next();
 if(status.ok!==true||status.active!==false)throw Error('HELPER_NOT_RECOVERED_AFTER_INIT_FAILURE');
 console.log(JSON.stringify({status:'BROWSER_UNTRUSTED_EXECUTABLE_REJECTED',error:failed.error,profileRemoved:true,helperAlive:true}));
}finally{
 rl.close();
 if(child.exitCode===null){try{child.stdin.end();}catch{}await Promise.race([once(child,'close'),new Promise(resolve=>setTimeout(resolve,1500))]);}
 if(child.exitCode===null)child.kill();
 try{fs.rmSync(profile,{recursive:true,force:true,maxRetries:3,retryDelay:50});}catch{}
}
