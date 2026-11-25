import test from 'node:test';
import assert from 'node:assert/strict';
import {createOwnerWorkspaceReadOnlyProxy} from '../src/owner-workspace-delegation.mjs';
const cfg=()=>({powerMode:{guiControl:{enabled:true}},ownerWorkspaceDelegation:{
 enabled:true,port:48838,authFile:'C:\\owner-workspace\\auth.key'}});
const healthyDenied=()=>({enabled:true,available:false,uncertain:false,blocked:false});
const auth='a'.repeat(64);
const windows=[{pid:50320,window_id:813514,app_name:'firefox.exe',title:'private browsing tab',cookies:'redact'},
 {pid:50321,window_id:813515,app_name:'notepad.exe',title:'secret content'}];
function fixture({primary=healthyDenied,rows=windows,status=200,secret=auth,extra={},port=48838}={}){
 const c=cfg();c.ownerWorkspaceDelegation.port=port;
 const calls=[];
 const broker=createOwnerWorkspaceReadOnlyProxy({config:c,platform:'win32',primaryStatus:primary,
  readFileImpl:async()=>secret,
  fetchImpl:async(url,init)=>{
   calls.push({url,init});
   return {status,text:async()=>JSON.stringify({jsonrpc:'2.0',id:1,...extra,
    result:{structuredContent:{ok:true,mode:'READ_ONLY',focusChanged:false,
      value:{windows:rows}}}})};
  }
 });
 return {broker,calls};
}
test('off by default and Windows only, with strict explicit loopback endpoint config',()=>{
 assert.equal(createOwnerWorkspaceReadOnlyProxy({config:{}}),null);
 assert.throws(()=>createOwnerWorkspaceReadOnlyProxy({config:cfg(),platform:'linux'}),/WINDOWS_ONLY/);
 const c=cfg();c.ownerWorkspaceDelegation.port=0;
 assert.throws(()=>createOwnerWorkspaceReadOnlyProxy({config:c,platform:'win32'}),/PORT_INVALID/);
 for(const port of [48837,48840,65535,'48838']){
  const incompatible=cfg();incompatible.ownerWorkspaceDelegation.port=port;
  assert.throws(()=>createOwnerWorkspaceReadOnlyProxy({config:incompatible,platform:'win32',primaryStatus:healthyDenied}),/PORT_INVALID/);
 }
});
test('authorized, native owner CUA list is sanitized and precisely Firefox filtered',async()=>{
 const {broker,calls}=fixture();
 const r=await broker.execute('workspace_target_list',{application:'firefox'});
 assert.equal(r.handled,true);
 assert.deepEqual(r.value.windows,[{processId:50320,handle:'813514',appName:'firefox.exe',focused:false}]);
 assert.equal(r.value.backend,'owner-cua-readonly');
 assert.equal(r.value.privateProfileAccess,false);
 assert.doesNotMatch(JSON.stringify(r.value),/private browsing|secret content|cookies/);
 assert.equal(calls.length,1);
 assert.equal(calls[0].url,'http://127.0.0.1:48838/mcp');
 assert.equal(JSON.parse(calls[0].init.body).params.name,'workspace_list_windows');
 assert.deepEqual(JSON.parse(calls[0].init.body).params.arguments,{});
 assert.equal(calls[0].init.headers['x-rc-owner-workspace-auth'],auth);
 assert.equal(calls[0].init.redirect,'error');
 assert.equal((await broker.execute('workspace_target_open',{processId:50320,handle:'813514'})).handled,false);
 assert.equal(calls.length,1,'mutation must never be delegated');
});
test('native windows list is exact, bounds checked, and does not infer identity from mutable title',async()=>{
 const {broker}=fixture({rows:[{pid:7,window_id:8,app_name:'notepad.exe',title:'firefox.exe'}]});
 const r=await broker.execute('workspace_target_list',{application:'firefox'});
 assert.equal(r.value.windows.length,0);
 for(const rows of [[{pid:0,window_id:1,app_name:'firefox'}],
 [{pid:5,window_id:7,app_name:'firefox.exe'},{pid:5,window_id:7,app_name:'firefox.exe'}],
 Array.from({length:501},(_,i)=>({pid:10+i,window_id:100+i,app_name:'firefox.exe'}))]){
  const item=fixture({rows});
  await assert.rejects(item.broker.execute('workspace_target_list',{}),/WINDOW_ID_INVALID|WINDOW_DUPLICATED|WINDOWS_INVALID/);
 }
});
test('blocked, uncertain, healthy-primary and missing native owner status cannot bridge',async()=>{
 for(const prop of [{blocked:true},{uncertain:true},{incidentPending:true},{incidentStoreUnavailable:true},{reason:'NATIVE_OUTCOME_UNCERTAIN_RESTART_REQUIRED'},{available:true},{enabled:false}]){
  const {broker,calls}=fixture({primary:()=>({...healthyDenied(),...prop})});
  assert.equal((await broker.execute('workspace_target_list',{})).handled,false);
  assert.equal(calls.length,0);
 }
 const {broker}=fixture({primary:()=>{throw Error('status unavailable')}});
 assert.equal((await broker.execute('workspace_target_list',{})).handled,false);
});
test('transport, credential, RPC and response errors fail closed',async()=>{
 await assert.rejects(fixture({secret:'not-a-secret'}).broker.execute('workspace_target_list',{}),/AUTH_INVALID/);
 await assert.rejects(fixture({status:403}).broker.execute('workspace_target_list',{}),/TRANSPORT_REJECTED/);
 await assert.rejects(fixture({extra:{error:{code:-32601,message:'denied'}}}).broker.execute('workspace_target_list',{}),/RPC_REJECTED/);
 await assert.rejects(fixture({rows:[{pid:3,window_id:9,app_name:undefined}]}).broker.execute('workspace_target_list',{}),/WINDOW_ID_INVALID/);
});

test('candidate read-only proxy uses only reviewed literal port 48839',async()=>{
 const {broker,calls}=fixture({port:48839});
 const result=await broker.execute('workspace_target_list',{application:'firefox'});
 assert.equal(result.handled,true);
 assert.equal(calls.length,1);
 assert.equal(calls[0].url,'http://127.0.0.1:48839/mcp');
});

test('read-only owner delegation rejects an oversized stream before fully buffering it',async()=>{
 let pushed=0;
 const total=8;
 const broker=createOwnerWorkspaceReadOnlyProxy({
  config:cfg(),platform:'win32',primaryStatus:healthyDenied,
  readFileImpl:async()=>auth,
  fetchImpl:async()=>new Response(new ReadableStream({
   pull(controller){if(pushed>=total){controller.close();return;}
    pushed++;controller.enqueue(new Uint8Array(65536));}
  }),{status:200})
 });
 await assert.rejects(()=>broker.execute('workspace_target_list',{}),/OWNER_WORKSPACE_RESPONSE_TOO_LARGE/);
 assert.ok(pushed<total,'all chunks were buffered before rejection: '+pushed);
});
