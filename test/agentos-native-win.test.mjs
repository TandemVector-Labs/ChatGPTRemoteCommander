import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {nativeWindowsUIACall} from '../src/agentos-native-win.mjs';
const req={pid:1234,windowId:9876,application:'brave'};
const fingerprint='0123456789abcdef01234567';
const foreground={
 foregroundStatus:'PRESERVED',foregroundTouched:false,
 foregroundBeforeWindowHandle:9876,foregroundBeforeProcessId:1234,
 foregroundAfterWindowHandle:9876,foregroundAfterProcessId:1234,
};
const base={ok:true,provider:'windows-uia-native',application:'brave',...req,
 windowHandle:req.windowId,physicalInputTouched:false,...foreground};
const observed={...base,mode:'NATIVE_UIA_OBSERVE',elements:[
 {name:'Message ChatGPT',controlType:'ControlType.Edit',fingerprint,valueAvailable:true,
  valueProvider:'ValuePattern',invokeAvailable:false,enabled:true},
 {name:'Send',controlType:'ControlType.Button',fingerprint:'fedcba9876543210fedcba98',
  valueAvailable:false,invokeAvailable:true,enabled:true}
]};
test('observe process argv is literal and shell-free, and only returns control capability metadata',async()=>{
 let call;const runner=async (...args)=>{call=args;return {stdout:JSON.stringify(observed)};};
 const result=await nativeWindowsUIACall('Observe',req,{platform:'win32',runner});
 assert.equal(result.elements.length,2);
 assert.equal(result.elements[0].valueAvailable,true);
 assert.equal(Object.hasOwn(result.elements[0],'value'),false);
 assert.equal(Object.hasOwn(result.elements[1],'value'),false);
 assert.equal(call[0],'pwsh.exe');
 assert.equal(call[2].shell,false);
 assert.equal(call[2].windowsHide,true);
 assert.equal(call[2].stdinText,undefined);
 assert.ok(!call[1].includes('Message ChatGPT'));
});
test('SetValue transports text over stdin only and validates SHA/readback without returning plaintext',async()=>{
 const value='A sensitive one-off qualification prompt';
 const hash=createHash('sha256').update(value,'utf8').digest('hex');
 let call;
 const response={...base,mode:'NATIVE_UIA_SET_VALUE',requestId:'brave-set-value-0001',
  valueApplied:true,readBackVerified:true,valueLength:value.length,valueSha256:hash,valueProvider:'ValuePattern'};
 const runner=async (...args)=>{call=args;return {stdout:JSON.stringify(response)};};
 const result=await nativeWindowsUIACall('SetValue',{...req,fingerprint,controlName:'Message ChatGPT',
  value,requestId:'brave-set-value-0001',foregroundChangeAuthorized:false,
  explicitUserAuthorization:'Owner authorizes one value set in the exact Brave field'},
  {platform:'win32',runner});
 assert.equal(call[0],'pwsh.exe');
 assert.equal(call[2].shell,false);
 assert.equal(call[2].stdinText,JSON.stringify({value})+'\n');
 assert.ok(!call[1].includes(value));
 assert.ok(!JSON.stringify(result).includes(value));
 assert.equal(result.valueSha256,hash);
 assert.equal(result.readBackVerified,true);
 assert.equal(Object.hasOwn(result,'value'),false);
});
test('SetValue rejects oversized, empty, NUL and unauthorised input before process spawn',async()=>{
 let calls=0;const runner=async()=>{calls++;return {stdout:'{}'};};
 const baseInput={...req,fingerprint,controlName:'Message ChatGPT',requestId:'brave-set-guard-0001',
  foregroundChangeAuthorized:false,explicitUserAuthorization:'Owner authorizes one exact UIA ValuePattern call'};
 for(const value of ['', 'x'.repeat(1025), 'x\u0000y']){
  await assert.rejects(nativeWindowsUIACall('SetValue',{...baseInput,value},{platform:'win32',runner}),
   /AGENTOS_NATIVE_SET_VALUE_CONTRACT_INVALID/);
 }
 await assert.rejects(nativeWindowsUIACall('SetValue',{...baseInput,value:'ok',explicitUserAuthorization:'short'},
  {platform:'win32',runner}),/AGENTOS_NATIVE_SET_VALUE_CONTRACT_INVALID/);
 assert.equal(calls,0);
});
test('SetValue refuses forged hash, readback and plaintext response',async()=>{
 const value='private prompt';const hash=createHash('sha256').update(value,'utf8').digest('hex');
 const input={...req,fingerprint,controlName:'Message ChatGPT',value,requestId:'brave-set-invalid-0001',
  foregroundChangeAuthorized:false,explicitUserAuthorization:'Owner authorizes one exact UIA value set'};
 const response={...base,mode:'NATIVE_UIA_SET_VALUE',requestId:input.requestId,valueApplied:true,
  readBackVerified:true,valueLength:value.length,valueSha256:'0'.repeat(64),valueProvider:'ValuePattern'};
 await assert.rejects(nativeWindowsUIACall('SetValue',input,{platform:'win32',
  runner:async()=>({stdout:JSON.stringify(response)})}),/AGENTOS_NATIVE_SET_VALUE_UNVERIFIED/);
 const leaked={...response,valueSha256:hash,value};
 await assert.rejects(nativeWindowsUIACall('SetValue',input,{platform:'win32',
  runner:async()=>({stdout:JSON.stringify(leaked)})}),/AGENTOS_NATIVE_SET_VALUE_UNVERIFIED/);
});
test('Invoke requires exact fingerprint, request id, explicit authorization and foreground evidence',async()=>{
 let calls=0;
 const input={...req,fingerprint,controlName:'Send',requestId:'brave-send-one-shot-0001',
  foregroundChangeAuthorized:false,explicitUserAuthorization:'Owner authorizes exactly one Send action'};
 const response={...base,mode:'NATIVE_UIA_INVOKE',requestId:input.requestId,
  invocationIssued:true,userGoalVerified:false};
 for(const bad of [{fingerprint:'x'},{requestId:'short'},{explicitUserAuthorization:'x'},
  {foregroundChangeAuthorized:'yes'},{controlName:''}]){
  await assert.rejects(nativeWindowsUIACall('Invoke',{...input,...bad},{platform:'win32',
   runner:async()=>{calls++;return {stdout:'{}'};}}),/AGENTOS_NATIVE_INVOKE_CONTRACT_INVALID/);
 }
 assert.equal(calls,0);
 const result=await nativeWindowsUIACall('Invoke',input,{platform:'win32',
  runner:async()=>({stdout:JSON.stringify(response)})});
 assert.equal(result.invocationIssued,true);
 assert.equal(result.userGoalVerified,false);
});
test('foreground consent is represented by an explicit PowerShell switch, never a string boolean',async()=>{
 const input={...req,fingerprint,controlName:'Send',requestId:'brave-send-focus-0001',
  foregroundChangeAuthorized:true,explicitUserAuthorization:'Owner permits this exact Brave foreground change'};
 const response={...base,mode:'NATIVE_UIA_INVOKE',requestId:input.requestId,
  invocationIssued:true,userGoalVerified:false,foregroundStatus:'CHANGED',foregroundTouched:true,
  foregroundBeforeWindowHandle:9877,foregroundBeforeProcessId:req.pid,
  foregroundAfterWindowHandle:req.windowId,foregroundAfterProcessId:req.pid};
 let argv;
 const result=await nativeWindowsUIACall('Invoke',input,{platform:'win32',
  runner:async(_bin,args)=>{argv=args;return {stdout:JSON.stringify(response)};}});
 assert.equal(result.foregroundStatus,'CHANGED');
 assert.ok(argv.includes('-ForegroundChangeAuthorized'));
 const noFocus={...input,requestId:'brave-send-no-focus-0001',foregroundChangeAuthorized:false};
 await nativeWindowsUIACall('Invoke',noFocus,{platform:'win32',
  runner:async(_bin,args)=>{assert.ok(!args.includes('-ForegroundChangeAuthorized'));return {stdout:JSON.stringify({
   ...base,mode:'NATIVE_UIA_INVOKE',requestId:noFocus.requestId,invocationIssued:true,userGoalVerified:false})};}});
});

test('target identity, app name, OS and malformed native output fail closed',async()=>{
 await assert.rejects(nativeWindowsUIACall('Observe',{...req,application:'edge'},{platform:'win32'}),/AGENTOS_NATIVE_INPUT_INVALID/);
 await assert.rejects(nativeWindowsUIACall('Observe',req,{platform:'linux'}),/AGENTOS_NATIVE_WINDOWS_ONLY/);
 await assert.rejects(nativeWindowsUIACall('Observe',req,{platform:'win32',
  runner:async()=>({stdout:JSON.stringify({...observed,pid:444})})}),/AGENTOS_NATIVE_RESPONSE_UNTRUSTED/);
 await assert.rejects(nativeWindowsUIACall('Observe',req,{platform:'win32',
  runner:async()=>({stdout:JSON.stringify({...observed,foregroundAfterWindowHandle:999})})}),/AGENTOS_NATIVE_RESPONSE_UNTRUSTED/);
});
test('an unavailable process launch is safe but timeout or lost receipt is UNCERTAIN and never replayed',async()=>{
 await assert.rejects(nativeWindowsUIACall('Observe',req,{platform:'win32',
  runner:async()=>{throw Object.assign(Error('missing'),{code:'ENOENT'});}}),/AGENTOS_NATIVE_POWERSHELL_UNAVAILABLE/);
 await assert.rejects(nativeWindowsUIACall('SetValue',{...req,fingerprint,controlName:'Message ChatGPT',
  value:'private',requestId:'brave-set-timeout-0001',foregroundChangeAuthorized:false,
  explicitUserAuthorization:'Owner authorizes one exact SetValue operation'},
  {platform:'win32',runner:async()=>{throw Error('lost receipt');}}),/AGENTOS_NATIVE_OUTCOME_UNCERTAIN/);
});
test('native PowerShell source uses UIA patterns, stdin and no global keyboard injection',()=>{
 const source=fs.readFileSync(new URL('../tools/native-windows-uia.ps1',import.meta.url),'utf8');
 assert.match(source,/ValuePattern/);
 assert.match(source,/GetCurrentPattern\(\[System\.Windows\.Automation\.ValuePattern\]::Pattern/);
 assert.doesNotMatch(source,/LegacyIAccessiblePattern/);
 assert.match(source,/SetValue/);assert.match(source,/Console\]::In/);
 assert.match(source,/Prefer text-capable Edit\/Document controls/);
 assert.match(source,/ControlType\.Edit','ControlType\.Document','ControlType\.Button/);
 assert.match(source,/\[switch\]\$ForegroundChangeAuthorized/);
 assert.match(source,/AGENTOS_FOREGROUND_TARGET_NOT_ACTIVE/);
 assert.match(source,/GetWindowThreadProcessId/);assert.match(source,/GetOwnerSid/);
 assert.doesNotMatch(source.replace(/^#.*$/gm,''),/SendInput|SendKeys|Clipboard/);
 assert.doesNotMatch(source,/param\([^)]*\$Value/s);
});
