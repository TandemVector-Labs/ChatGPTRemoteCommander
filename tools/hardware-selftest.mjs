import fs from 'node:fs';
import os from 'node:os';
import { validateHardwareSelftestEndpoint } from './hardware-selftest-endpoint.mjs';
import { readBoundedHardwareResponse } from './hardware-selftest-response.mjs';

function fail(code,detail=''){const e=new Error(detail?code+': '+detail:code);e.code=code;throw e;}
function parse(argv){
  const o={timeoutMs:10000};
  for(let i=0;i<argv.length;i++){
    const a=argv[i],v=argv[++i];if(v===undefined)fail('SELFTEST_ARGUMENT');
    if(a==='--url')o.url=v;
    else if(a==='--config')o.config=v;
    else if(a==='--expected-version')o.expectedVersion=v;
    else if(a==='--expected-device')o.expectedDevice=v;
    else if(a==='--timeout-ms')o.timeoutMs=Number(v);
    else fail('SELFTEST_ARGUMENT',a);
  }
  if(!o.url||!o.config)fail('SELFTEST_REQUIRED');
  if(!Number.isSafeInteger(o.timeoutMs)||o.timeoutMs<500||o.timeoutMs>60000)fail('SELFTEST_TIMEOUT');
  o.url=validateHardwareSelftestEndpoint(o.url);
  return o;
}
async function readBounded(r){
  const t=await readBoundedHardwareResponse(r);
  if(!r.ok)fail('SELFTEST_HTTP_'+r.status,t.slice(0,300));
  return t?JSON.parse(t):null;
}
async function rpc(url,method,params,id,timeoutMs){
  const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,...(params?{params}:{})}),redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
  const b=await readBounded(r);if(b?.error)fail('SELFTEST_RPC',b.error.message||'RPC error');return b?.result;
}
async function tool(url,name,args,id,timeoutMs){
  const r=await rpc(url,'tools/call',{name,arguments:args??{}},id,timeoutMs);
  if(r?.isError)fail('SELFTEST_TOOL_'+name,(r.content??[]).map(x=>x?.text).filter(Boolean).join(' ').slice(0,500));
  return r?.structuredContent??r;
}
const o=parse(process.argv.slice(2));
const selftestRequestId=(label)=>`hardware-selftest-${process.pid}-${label}`;
const config=JSON.parse(fs.readFileSync(o.config,'utf8'));
let id=1;
const status=await tool(o.url,'system_status',{},id++,o.timeoutMs);
if(o.expectedVersion&&status.version!==o.expectedVersion)fail('SELFTEST_VERSION');
if(o.expectedDevice&&status.deviceName!==o.expectedDevice)fail('SELFTEST_DEVICE');
const profile=config.instance?.profile??'default';
if(status.instance?.profile!==profile)fail('SELFTEST_PROFILE');
const report={ok:true,platform:status.platform,arch:status.arch,version:status.version,profile,checks:[]};
const pass=(name,detail='PASS')=>report.checks.push({name,ok:true,detail});
pass('system_status',status.deviceName);
if(config.capabilityProfile?.tier==='FULL_POWER'){
  if(status.capabilityProfile?.tier!=='FULL_POWER'||status.capabilityProfile?.autoEnableNewCapabilities!==true)fail('SELFTEST_FULL_POWER_PROFILE');
  const disabled=new Set(config.capabilityProfile?.disabledCapabilities??[]);
  const expect=(cap,value,code)=>{if(!disabled.has(cap)&&value!==true)fail(code);};
  expect('filesystem.full',status.powerMode?.fullFilesystem,'SELFTEST_FULL_FILESYSTEM');
  expect('shell.execute',status.powerMode?.allowShell,'SELFTEST_SHELL');
  expect('process.control',status.powerMode?.allowProcessControl,'SELFTEST_PROCESS');
  expect('filesystem.permanent_delete',status.powerMode?.allowPermanentDelete,'SELFTEST_DELETE');
  await tool(o.url,'power_status',{},id++,o.timeoutMs);pass('power_status');
  await tool(o.url,'file_info',{path:os.tmpdir()},id++,o.timeoutMs);pass('file_info');
  await tool(o.url,'system_info',{},id++,o.timeoutMs);pass('system_info');
  await tool(o.url,'list_processes',{},id++,o.timeoutMs);pass('list_processes');
  if(!disabled.has('shell.execute')){
    const marker='RC_HARDWARE_SELFTEST_PASS';
    const cmd=status.platform==='win32'?'Write-Output '+marker:'printf '+marker;
    const sh=await tool(o.url,'run_shell',{requestId:selftestRequestId('run-shell'),command:cmd,timeoutMs:10000},id++,o.timeoutMs);
    if(!String(sh?.stdout??'').includes(marker))fail('SELFTEST_SHELL_E2E');
    pass('run_shell');
  }
  if(config.powerMode?.guiControl?.enabled===true&&status.guiControl?.backendSupported===true){
    await tool(o.url,'gui_status',{},id++,o.timeoutMs);pass('gui_status');
  }else if(config.powerMode?.guiControl?.enabled===true){
    pass('gui_status','authorized but backend unavailable on this platform');
  }
  if(config.powerMode?.browserControl?.enabled===true){
    const bs=await tool(o.url,'browser_status',{},id++,o.timeoutMs);
    if(bs?.available===true){
      const begun=await tool(o.url,'browser_session_begin',{requestId:selftestRequestId('browser-begin'),mode:'isolated',profile:'hardware',ttlSeconds:30},id++,Math.max(o.timeoutMs,30000));
      if(begun?.background!==true||begun?.userDesktopTouched!==false||begun?.savedPasswordStoreAccess!==false)fail('SELFTEST_BROWSER_POLICY');
      await tool(o.url,'browser_session_end',{requestId:selftestRequestId('browser-end'),lease:begun.lease},id++,Math.max(o.timeoutMs,30000));
      pass('browser_background',bs.backend??'available');
    }else{
      pass('browser_background','authorized but Chromium background backend unavailable on this host');
    }
  }
}
if(config.durableWorkflows?.enabled===true){
  const wf=await tool(o.url,'workflow_health',{},id++,o.timeoutMs);
  if(wf?.ok!==true||wf?.databaseIntegrity!=='ok')fail('SELFTEST_WORKFLOW_HEALTH');
  pass('workflow_health','schema='+wf.databaseSchemaVersion);
}
console.log(JSON.stringify(report,null,2));
console.log('HARDWARE_SELFTEST_PASS');
