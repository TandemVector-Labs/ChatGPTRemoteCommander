import { rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { browserError } from './browser-contract.mjs';
import { terminateProcessesUsingBrowserProfile } from './browser-owned-processes.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function parseEnvelope(bytes){
 let value;
 try{
  value=JSON.parse(Buffer.isBuffer(bytes)?bytes.toString('utf8'):String(bytes));
  if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.ok!=='boolean')throw new Error();
 }catch{throw browserError('BROWSER_HELPER_BAD_JSON');}
 return value;
}
function applicationError(value){
 const code=/^[A-Z][A-Z0-9_]{1,79}$/.test(value?.error??'')?value.error:'BROWSER_NATIVE_FAILED';
 return browserError(code);
}
async function removeOwnedProfile(profile){
 if(typeof profile!=='string'||!profile)return;
 let lastError=null;
 for(let i=0;i<80;i++){
  try{await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:80});return;}
  catch(error){lastError=error;await sleep(50);}
 }
 if(lastError)throw browserError('BROWSER_PROFILE_CLEANUP_FAILED');
}
async function waitForClose(child,ms){
 if(!child||child.exitCode!==null)return;
 await Promise.race([new Promise(resolve=>child.once('close',resolve)),sleep(ms)]);
}
async function forceTree(child,forceCloseMs){
 if(!child||child.exitCode!==null)return;
 if(process.platform==='win32'){
  const attemptMs=Math.max(1000,Number(forceCloseMs)||0);
  let treeStopped=false;
  for(let attempt=0;attempt<3&&child.exitCode===null;attempt++){
   try{
    const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true,shell:false});
    await waitForClose(killer,attemptMs);
    await waitForClose(child,attemptMs);
    if(child.exitCode!==null){treeStopped=true;break;}
   }catch{}
  }
  if(!treeStopped&&child.exitCode===null){try{child.kill();}catch{}}
 }else{
  try{process.kill(-child.pid,'SIGKILL');}catch{try{child.kill('SIGKILL');}catch{}}
 }
 await waitForClose(child,Math.max(forceCloseMs,1000));
}
export function createBrowserProcessClient({file,args,timeoutMs=15000,slowActionTimeoutMs=35000,startupTimeoutMs=15000,maxBytes=8*1024*1024,env=process.env,gracefulCloseMs=2500,forceCloseMs=1500}){
 let child=null,buffer=Buffer.alloc(0),startup=null,pending=null,stderrBytes=0,reserved=false,shutdown=null,ownedProfile=null,ownedProfileIsolated=false;
 const clear=t=>{if(t)clearTimeout(t);};
 const beginShutdown=()=>{
  if(shutdown)return shutdown;
  const c=child;child=null;
  const profile=ownedProfile,removeProfile=ownedProfileIsolated;ownedProfile=null;ownedProfileIsolated=false;
  buffer=Buffer.alloc(0);
  shutdown=(async()=>{
   if(c&&c.exitCode===null){
    try{c.stdin.end();}catch{}
    await waitForClose(c,gracefulCloseMs);
    if(c.exitCode===null)await forceTree(c,forceCloseMs);
   }
   if(profile)terminateProcessesUsingBrowserProfile(profile);
   if(removeProfile)await removeOwnedProfile(profile);
  })().finally(()=>{shutdown=null;});
  return shutdown;
 };
 const fail=code=>{
  const error=browserError(code);reserved=false;
  if(startup){const s=startup;clear(s.timer);startup=null;s.reject(error);}
  if(pending){const p=pending;clear(p.timer);pending=null;p.reject(error);}
  buffer=Buffer.alloc(0);
  void beginShutdown().catch(()=>{});
 };
 const complete=line=>{
  let value;try{value=parseEnvelope(line);}catch(e){fail(e.browserCode??'BROWSER_HELPER_BAD_JSON');return;}
  if(startup){
   if(value.ok!==true||value.ready!==true||value.protocol!==1){fail('BROWSER_HELPER_BAD_JSON');return;}
   const s=startup;clear(s.timer);startup=null;s.resolve();return;
  }
  if(!pending){fail('BROWSER_HELPER_BAD_JSON');return;}
  const p=pending;clear(p.timer);pending=null;
  if(value.ok!==true){p.reject(applicationError(value));return;}
  p.resolve(value);
 };
 const consume=chunk=>{
  if(!child)return;
  buffer=buffer.length?Buffer.concat([buffer,chunk]):Buffer.from(chunk);
  const limit=startup?65536:pending?maxBytes:65536;
  if(buffer.length>limit&&buffer.indexOf(0x0a)===-1){fail('BROWSER_HELPER_OUTPUT_LIMIT');return;}
  while(child){
   const nl=buffer.indexOf(0x0a);if(nl<0)break;
   if(nl>(startup?65536:maxBytes)){fail('BROWSER_HELPER_OUTPUT_LIMIT');return;}
   let line=buffer.subarray(0,nl);buffer=buffer.subarray(nl+1);
   if(line.length&&line[line.length-1]===0x0d)line=line.subarray(0,-1);
   if(!line.length){fail('BROWSER_HELPER_BAD_JSON');return;}
   complete(line);
  }
 };
 const start=async()=>{
  if(shutdown)await shutdown;
  if(child&&child.exitCode===null&&!child.killed&&!startup)return;
  if(startup)return startup.promise;
  buffer=Buffer.alloc(0);stderrBytes=0;
  let spawned;try{spawned=spawn(file,args,{windowsHide:true,env,stdio:['pipe','pipe','pipe'],shell:false,detached:process.platform!=='win32'});}
  catch{throw browserError('BROWSER_HELPER_START_FAILED');}
  child=spawned;
  let resolveStart,rejectStart;const promise=new Promise((resolve,reject)=>{resolveStart=resolve;rejectStart=reject;});
  startup={promise,resolve:resolveStart,reject:rejectStart,timer:null};
  startup.timer=setTimeout(()=>fail('BROWSER_HELPER_TIMEOUT'),startupTimeoutMs);
  spawned.once('error',()=>fail('BROWSER_HELPER_START_FAILED'));
  spawned.stdin.on('error',()=>fail('BROWSER_HELPER_STDIN_FAILED'));
  spawned.stdout.on('data',consume);
  spawned.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>32768)fail('BROWSER_HELPER_OUTPUT_LIMIT');});
  spawned.once('close',()=>{
   if(child!==spawned)return;
   buffer=Buffer.alloc(0);
   if(startup||pending)fail('BROWSER_HELPER_EXIT_FAILED');
   else void beginShutdown().catch(()=>{});
  });
  return promise;
 };
 const invoke=async request=>{
  if(pending||reserved)throw browserError('BROWSER_HELPER_BUSY');
  reserved=true;
  let trackedStartProfile=null,trackedStartIsolated=false;
  try{
   await start();
   if(!child||child.exitCode!==null||child.killed)throw browserError('BROWSER_HELPER_EXIT_FAILED');
   if(pending)throw browserError('BROWSER_HELPER_BUSY');
   if(request?.action==='start'&&typeof request.profileDir==='string'&&request.profileDir){
    trackedStartProfile=request.profileDir;trackedStartIsolated=request.isolated===true;
    ownedProfile=request.profileDir;ownedProfileIsolated=trackedStartIsolated;
   }
   const promise=new Promise((resolve,reject)=>{
    const prolonged=['navigate','wait','transfer_upload','transfer_download'].includes(request?.action);
    const operationTimeout=prolonged?Math.max(timeoutMs,Math.min(35000,slowActionTimeoutMs)):timeoutMs;
    pending={resolve,reject,timer:setTimeout(()=>fail('BROWSER_HELPER_TIMEOUT'),operationTimeout)};
    reserved=false;
    child.stdin.write(JSON.stringify(request)+'\n','utf8',error=>{if(error)fail('BROWSER_HELPER_STDIN_FAILED');});
   });
   try{
    const result=await promise;
    if(request?.action==='end'){ownedProfile=null;ownedProfileIsolated=false;}
    return result;
   }catch(error){
    if(trackedStartProfile){
     if(ownedProfile===trackedStartProfile){ownedProfile=null;ownedProfileIsolated=false;}
     terminateProcessesUsingBrowserProfile(trackedStartProfile);
     if(trackedStartIsolated)void removeOwnedProfile(trackedStartProfile).catch(()=>{});
    }
    throw error;
   }
  }finally{
   reserved=false;
  }
 };
 const close=()=>{
  reserved=false;
  if(shutdown)return shutdown;
  const hadActive=!!startup||!!pending;
  if(hadActive){
   const error=browserError('BROWSER_HELPER_EXIT_FAILED');
   if(startup){const s=startup;clear(s.timer);startup=null;s.reject(error);}
   if(pending){const p=pending;clear(p.timer);pending=null;p.reject(error);}
  }
  return beginShutdown();
 };
 return {invoke,close};
}
