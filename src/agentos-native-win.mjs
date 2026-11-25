import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const exec=promisify(execFile);
const script=fileURLToPath(new URL('../tools/native-windows-uia.ps1',import.meta.url));
const positive=v=>Number.isSafeInteger(v)&&v>0&&v<=2147483647;
const windowHandle=v=>Number.isSafeInteger(v)&&v>0;
const finger=/^[a-f0-9]{24}$/;
const request=/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const applications=new Set(['brave','chrome','msedge','firefox']);
function fail(code){return Object.assign(new Error(code),{code});}
function runPowerShell(binary,args,options={}){
 const {stdinText,...execOptions}=options;
 if(stdinText===undefined)return exec(binary,args,execOptions);
 return new Promise((resolve,reject)=>{
  let child,stdout='',stderr='',settled=false,timer=null;
  const limit=options.maxBuffer??128*1024;
  const finish=(err,value)=>{if(settled)return;settled=true;if(timer)clearTimeout(timer);if(err)reject(err);else resolve(value);};
  const {timeout,maxBuffer,encoding,...spawnOptions}=execOptions;
  try{
   child=spawn(binary,args,{...spawnOptions,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
  }catch{finish(fail('AGENTOS_NATIVE_PROCESS_START_FAILED'));return;}
  timer=setTimeout(()=>{try{child.kill();}catch{}finish(fail('AGENTOS_NATIVE_OUTCOME_UNCERTAIN'));},timeout??16000);
  child.stdout.on('data',chunk=>{
   stdout+=chunk.toString('utf8');
   if(Buffer.byteLength(stdout,'utf8')>limit){try{child.kill();}catch{}finish(fail('AGENTOS_NATIVE_RESPONSE_TOO_LARGE'));}
  });
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString('utf8')).slice(-4096);});
  child.once('error',e=>finish(fail(e?.code==='ENOENT'?'AGENTOS_NATIVE_POWERSHELL_UNAVAILABLE':'AGENTOS_NATIVE_PROCESS_START_FAILED')));
  child.once('close',code=>{
   if(code!==0){
    const known=stderr.match(/AGENTOS_[A-Z0-9_]+/);
    finish(fail(known?.[0]??'AGENTOS_NATIVE_OUTCOME_UNCERTAIN'));
   }else finish(null,{stdout});
  });
  child.stdin.on('error',()=>{});
  child.stdin.end(stdinText,'utf8');
 });
}
function foregroundValid(response){
 const beforeHandle=response?.foregroundBeforeWindowHandle;
 const afterHandle=response?.foregroundAfterWindowHandle;
 const beforePid=response?.foregroundBeforeProcessId;
 const afterPid=response?.foregroundAfterProcessId;
 const pairValid=(h,p)=>(h===null&&p===null)||(windowHandle(h)&&positive(p));
 if(!pairValid(beforeHandle,beforePid)||!pairValid(afterHandle,afterPid))return false;
 const same=beforeHandle!==null&&afterHandle!==null&&beforeHandle===afterHandle&&beforePid===afterPid;
 const changed=beforeHandle!==null&&afterHandle!==null&&(beforeHandle!==afterHandle||beforePid!==afterPid);
 return (response.foregroundStatus==='PRESERVED'&&response.foregroundTouched===false&&same)
  ||(response.foregroundStatus==='CHANGED'&&response.foregroundTouched===true&&changed)
  ||(response.foregroundStatus==='UNOBSERVABLE'&&response.foregroundTouched===null&&
     (beforeHandle===null||afterHandle===null));
}
// UIA is an exact-process semantic provider. SetValue text travels only over stdin,
// never argv, environment variables, temporary files or standard output.
export async function nativeWindowsUIACall(operation,input={},{
 platform=process.platform,runner=runPowerShell,powershell='pwsh.exe'
}={}){
 if(platform!=='win32')throw fail('AGENTOS_NATIVE_WINDOWS_ONLY');
 if(!['Observe','SetValue','Invoke'].includes(operation)||!positive(input.pid)||
    !windowHandle(input.windowId)||!applications.has(input.application))
  throw fail('AGENTOS_NATIVE_INPUT_INVALID');
 const args=['-NoLogo','-NoProfile','-NonInteractive','-File',script,
  '-Operation',operation,'-TargetPid',String(input.pid),'-WindowHandle',String(input.windowId),
  '-ExpectedProcessName',input.application];
 if(operation==='Observe'){
  if(input.maxElements!==undefined&&(!Number.isInteger(input.maxElements)||input.maxElements<1||input.maxElements>100))
   throw fail('AGENTOS_NATIVE_INPUT_INVALID');
  args.push('-MaxElements',String(input.maxElements??70));
 }else{
  if(!finger.test(input.fingerprint??'')||typeof input.controlName!=='string'||
    !input.controlName.length||input.controlName.length>150||
    !request.test(input.requestId??'')||
    typeof input.explicitUserAuthorization!=='string'||
    input.explicitUserAuthorization.trim().length<12||input.explicitUserAuthorization.length>512||
    typeof input.foregroundChangeAuthorized!=='boolean')
   throw fail(operation==='SetValue'?'AGENTOS_NATIVE_SET_VALUE_CONTRACT_INVALID':'AGENTOS_NATIVE_INVOKE_CONTRACT_INVALID');
  args.push('-Fingerprint',input.fingerprint,'-ControlName',input.controlName,
    '-RequestId',input.requestId,'-ExplicitUserAuthorization',input.explicitUserAuthorization);
  if(input.foregroundChangeAuthorized===true)args.push('-ForegroundChangeAuthorized');
 }
 const options={
  shell:false,windowsHide:true,encoding:'utf8',timeout:operation==='Observe'?11000:16000,
  maxBuffer:128*1024
 };
 if(operation==='SetValue'){
  if(typeof input.value!=='string'||input.value.length<1||input.value.length>1024||
     input.value.includes('\u0000'))
   throw fail('AGENTOS_NATIVE_SET_VALUE_CONTRACT_INVALID');
  options.stdinText=JSON.stringify({value:input.value})+'\n';
 }
 let stdout;
 try{({stdout}=await runner(powershell,args,options));}
 catch(e){
  if(e?.code==='ENOENT'||e?.code==='AGENTOS_NATIVE_POWERSHELL_UNAVAILABLE')throw fail('AGENTOS_NATIVE_POWERSHELL_UNAVAILABLE');
  if(typeof e?.code==='string'&&/^AGENTOS_[A-Z0-9_]+$/.test(e.code))throw fail(e.code);
  throw fail('AGENTOS_NATIVE_OUTCOME_UNCERTAIN');
 }
 let response;
 try{response=JSON.parse(stdout.trim());}catch{throw fail('AGENTOS_NATIVE_RESPONSE_INVALID');}
 if(response?.ok!==true||response?.pid!==input.pid||response?.windowHandle!==input.windowId||
   response?.provider!=='windows-uia-native'||response?.application!==input.application||
   response?.physicalInputTouched!==false||!foregroundValid(response))
  throw fail('AGENTOS_NATIVE_RESPONSE_UNTRUSTED');
 if(operation==='Observe'){
  if(response.mode!=='NATIVE_UIA_OBSERVE'||!Array.isArray(response.elements)||
    response.elements.length>100||
    response.elements.some(x=>typeof x.name!=='string'||
      typeof x.fingerprint!=='string'||!finger.test(x.fingerprint)||
      typeof x.invokeAvailable!=='boolean'||typeof x.valueAvailable!=='boolean'||
      typeof x.enabled!=='boolean'||typeof x.controlType!=='string'||
      !['Edit','Document','Button'].some(t=>x.controlType.endsWith(t))))
   throw fail('AGENTOS_NATIVE_RESPONSE_UNTRUSTED');
 }else if(operation==='SetValue'){
  const expectedHash=createHash('sha256').update(input.value,'utf8').digest('hex');
  if(response.mode!=='NATIVE_UIA_SET_VALUE'||response.requestId!==input.requestId||
    response.valueApplied!==true||response.readBackVerified!==true||
    response.valueLength!==input.value.length||response.valueSha256!==expectedHash||
    response.valueProvider!=='ValuePattern'||
    Object.prototype.hasOwnProperty.call(response,'value'))
   throw fail('AGENTOS_NATIVE_SET_VALUE_UNVERIFIED');
 }else if(response.mode!=='NATIVE_UIA_INVOKE'||response.requestId!==input.requestId||
    response.invocationIssued!==true||response.userGoalVerified!==false)
  throw fail('AGENTOS_NATIVE_RESPONSE_UNTRUSTED');
 return response;
}
