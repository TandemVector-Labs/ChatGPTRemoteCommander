import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import http from 'node:http';

const helper=fileURLToPath(new URL('../tools/browser-control.mjs',import.meta.url));
const seenCookies=[];
const server=http.createServer((req,res)=>{seenCookies.push(req.headers.cookie??'');res.writeHead(200,{'content-type':'text/html; charset=utf-8','set-cookie':'rc_profile=kept; Path=/; SameSite=Lax','cache-control':'no-store','connection':'close'});res.end('<!doctype html><title>profile continuity</title><p>ok</p>');});
server.listen(0,'127.0.0.1');await once(server,'listening');
let serverClosed=false;
const closeServer=async()=>{if(serverClosed)return;try{server.closeAllConnections?.();}catch{}await new Promise(resolve=>server.close(resolve));serverClosed=true;};
const localUrl='http://127.0.0.1:'+server.address().port+'/continuity';
const profile=path.join(os.tmpdir(),'rc-browser-eof-'+process.pid+'-'+Date.now().toString(36));
const child=spawn(process.execPath,[helper,'--server'],{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});
let stderr='';child.stderr.on('data',c=>stderr+=c.toString('utf8'));
const rl=createInterface({input:child.stdout,crlfDelay:Infinity});
const it=rl[Symbol.asyncIterator]();
async function bounded(promise,ms,code){
 let timer;
 try{
  return await Promise.race([promise,new Promise((_,reject)=>{
   timer=setTimeout(()=>reject(Error(code)),ms);
  })]);
 }finally{clearTimeout(timer);}
}
const next=async()=>{
 const result=await bounded(it.next(),30000,'HELPER_LINE_TIMEOUT');
 if(result.done)throw Error('HELPER_EOF '+stderr.slice(-500));
 return JSON.parse(result.value);
};
const send=o=>child.stdin.write(JSON.stringify(o)+'\n');
try{
 const ready=await next();if(ready.ok!==true||ready.ready!==true)throw Error('HELPER_NOT_READY');
 send({action:'status'});const status=await next();
 if(status.available!==true){
  console.log(JSON.stringify({status:'BROWSER_EOF_SKIP',reason:'NO_CHROMIUM_BROWSER'}));
 }else{
  send({action:'start',profileDir:profile,isolated:true});const started=await next();
  if(started.ok!==true||started.background!==true)throw Error('BROWSER_START_FAIL '+JSON.stringify(started));
  const firstPortFile=path.join(profile,'DevToolsActivePort');
  const firstPort=Number(fs.readFileSync(firstPortFile,'utf8').trim().split(/\r?\n/)[0]);
  send({action:'navigate',url:localUrl,timeoutMs:10000});const navigated=await next();
  if(navigated.ok!==true||!String(navigated.url||'').startsWith(localUrl))throw Error('BROWSER_LOCAL_NAVIGATE_FAIL');
  send({action:'relaunch',headless:true});const relaunched=await next();
  if(relaunched.ok!==true||relaunched.headless!==true||relaunched.sameOwnedProfile!==true)throw Error('BROWSER_RELAUNCH_FAIL');
  if(!String(relaunched.resumedUrl||'').startsWith(localUrl))throw Error('BROWSER_RELAUNCH_URL_LOST');
  const secondPort=Number(fs.readFileSync(firstPortFile,'utf8').trim().split(/\r?\n/)[0]);
  if(!Number.isInteger(firstPort)||!Number.isInteger(secondPort)||firstPort<1||secondPort<1)throw Error('BROWSER_RELAUNCH_PORT_INVALID');
  if(!seenCookies.some(value=>value.includes('rc_profile=kept')))throw Error('BROWSER_RELAUNCH_PROFILE_STATE_LOST');
  await closeServer();
  send({action:'relaunch',headless:true});const degraded=await next();
  if(degraded.ok!==true||degraded.headless!==true||degraded.sameOwnedProfile!==true||degraded.resumeNavigationFailed!==true)throw Error('BROWSER_HEADLESS_RELAUNCH_FAILURE_RECOVERY_FAIL');
  send({action:'status'});const recoveredStatus=await next();
  if(recoveredStatus.ok!==true||recoveredStatus.active!==true||recoveredStatus.headless!==true||recoveredStatus.foreground!==false)throw Error('BROWSER_HEADLESS_RECOVERY_MODE_FAIL');
  const portFile=path.join(profile,'DevToolsActivePort');
  if(!fs.existsSync(portFile))throw Error('DEVTOOLS_PORT_FILE_MISSING');
  const port=Number(fs.readFileSync(portFile,'utf8').trim().split(/\r?\n/)[0]);
  if(!Number.isInteger(port)||port<1)throw Error('DEVTOOLS_PORT_INVALID');
  child.stdin.end();
  await bounded(once(child,'close'),25000,'HELPER_CLOSE_TIMEOUT');
  let removed=false;
  for(let i=0;i<80;i++){if(!fs.existsSync(profile)){removed=true;break;}await new Promise(r=>setTimeout(r,50));}
  if(!removed)throw Error('ISOLATED_PROFILE_NOT_REMOVED_AFTER_EOF');
  let devtoolsAlive=false;
  try{const response=await fetch('http://127.0.0.1:'+port+'/json/version',{signal:AbortSignal.timeout(500)});devtoolsAlive=response.ok;}catch{}
  if(devtoolsAlive)throw Error('CHROMIUM_SURVIVED_HELPER_EOF');
  console.log(JSON.stringify({status:'BROWSER_EOF_CLEANUP_PASS',profileRemoved:true,devtoolsClosed:true}));
 }
}finally{
 rl.close();
 if(child.exitCode===null){try{child.stdin.end();}catch{}child.kill();}
 for(let i=0;i<10&&fs.existsSync(profile);i++){try{fs.rmSync(profile,{recursive:true,force:true,maxRetries:3,retryDelay:50});}catch{}await new Promise(r=>setTimeout(r,50));}
 if(!serverClosed)await closeServer();
}
