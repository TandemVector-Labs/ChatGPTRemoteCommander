import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createWorkspaceController,resolveOwnerCuaPipe,assertWorkspaceToolPolicy} from '../src/workspace-tools.mjs';
import {createMemoryWorkspaceJournal} from '../src/workspace-target-journal.mjs';

test('owner CUA pipe is channel-scoped and rejects shared or caller-selected endpoints',()=>{
 const prefix='\\\\.\\pipe\\rc-workspace-cua-v038-';
 assert.equal(resolveOwnerCuaPipe({}),prefix+'active');
 assert.equal(resolveOwnerCuaPipe({RC_WORKSPACE_CUA_PIPE:prefix+'active'}),prefix+'active');
 assert.equal(resolveOwnerCuaPipe({RC_WORKSPACE_CUA_PIPE:prefix+'candidate'}),prefix+'candidate');
 for(const pipe of [
  '\\\\.\\pipe\\rc-workspace-cua-v038',
  '\\\\.\\pipe\\other-owner',
  'http://127.0.0.1:48838',
  prefix+'unknown'
 ]) assert.throws(()=>resolveOwnerCuaPipe({RC_WORKSPACE_CUA_PIPE:pipe}),/WORKSPACE_CUA_OWNER_PIPE_INVALID/);
});

const makeController=(driver)=>createWorkspaceController({
 ownerSession:async()=>true,
 now:()=>5000,
 journal:createMemoryWorkspaceJournal(),
 callDriver:driver
});

test('browser inspect and attach revive exact native CUA session before use',async()=>{
 const calls=[];
 const ctl=makeController(async(name,args)=>{
  calls.push({name,args});
  if(name==='start_session')return {status:'ok'};
  if(name==='get_browser_state')return {status:'refused',refusal:{code:'browser_consent_required'}};
  if(name==='browser_prepare')return {status:'refused',refusal:{code:'browser_route_unavailable'}};
  throw new Error('UNEXPECTED_CUA_TOOL_'+name);
 });
 const pid=32092,windowId=133238;
 const inspected=await ctl.execute('workspace_browser_inspect',{pid,windowId});
 assert.equal(inspected.ok,false);
 assert.equal(inspected.code,'browser_consent_required');
 const attach=await ctl.execute('workspace_browser_attach',{pid,windowId,
  explicitUserAuthorization:'Owner authorized exact-session browser attach for this contract test'});
 assert.equal(attach.ok,false);
 assert.equal(attach.errorCode,'browser_route_unavailable');
 assert.deepEqual(calls.map(v=>v.name),
  ['start_session','get_browser_state','start_session','browser_prepare']);
 assert.ok(calls.every(v=>v.args.session==='rcws-32092-133238'));
});

test('invalid window requestId fails before driver effects, valid click is at most once',async()=>{
 let effects=0;
 const ctl=makeController(async(name)=>{
  if(name==='get_window_state')return {snapshot_id:'s00000012',elements:[]};
  if(name==='click'){effects++;return {effect:'confirmed',verified:true};}
  throw new Error('UNEXPECTED_DRIVER_CALL_'+name);
 });
 const input={pid:32092,windowId:133238,elementToken:'s00000012:1',
  explicitUserAuthorization:'Owner authorized one synthetic isolated click'};
 await ctl.execute('workspace_window_observe',input);
 for(const requestId of [undefined,null,1,{},true])
  await assert.rejects(ctl.execute('workspace_window_click',{...input,requestId}),
   /WORKSPACE_BINDING_INVALID/);
 assert.equal(effects,0);
 const command={...input,requestId:'rc011-contract-once-01'};
 assert.equal((await ctl.execute('workspace_window_click',command)).ok,true);
 assert.equal(effects,1);
 await assert.rejects(ctl.execute('workspace_window_click',command),
  /WORKSPACE_DUPLICATE_REQUEST_NO_REPLAY/);
 assert.equal(effects,1);
});

test('server preserves the caller requestId in delegated background window and browser effects',async()=>{
 const server=await readFile(new URL('../src/server-v0.3.mjs',import.meta.url),'utf8');
 assert.match(server,/const forwarded = name==='workspace_window_click'\|\|name==='workspace_window_type'\|\|name==='workspace_browser_click'/);
 assert.match(server,/executeToolEffect\(name, forwarded, \{ requestId \}\)/);
 assert.match(server,/name==='workspace_window_type'/);
});

test('same-owner typed input requires a fresh matching named field and keyboard policy',async()=>{
 const calls=[];
 const ctl=makeController(async(name,args)=>{
  calls.push({name,args});
  if(name==='start_session')return {status:'ok'};
  if(name==='get_window_state')return {snapshot_id:'s00000019',elements:[
   {role:'entry',label:'Ask ChatGPT',element_token:'s00000019:1',enabled:true},
   {role:'text',label:'KDE text input',actions:['SetFocus'],element_token:'s00000019:2',enabled:true},
   {role:'text',label:'Static label',actions:[],element_token:'s00000019:3',enabled:true},
   {role:'entry',label:'Password',element_token:'s00000019:4',enabled:true},
   {role:'button',label:'Send',element_token:'s00000019:5',enabled:true}
  ]};
  if(name==='type_text')return {effect:'confirmed',verified:true};
  throw new Error('UNEXPECTED_DRIVER_TOOL_'+name);
 });
 const id={pid:32092,windowId:133238};
 const args={...id,controlName:'Ask ChatGPT',elementToken:'s00000019:1',
  text:'nonsecret sample',requestId:'mmz-typed-entry-01',
  explicitUserAuthorization:'Owner approved only this synthetic editable field'};
 const power={powerMode:{enabled:true,guiControl:{enabled:true,allowKeyboard:true,allowMouse:false}}};
 assert.doesNotThrow(()=>assertWorkspaceToolPolicy(power,'workspace_window_type',args));
 assert.throws(()=>assertWorkspaceToolPolicy({powerMode:{enabled:true,guiControl:{enabled:true,allowKeyboard:false,allowMouse:true}}},'workspace_window_type',args),/WORKSPACE_GUI_KEYBOARD_POLICY_DENIED/);
 await ctl.execute('workspace_window_observe',id);
 for(const [controlName,elementToken] of [['Static label','s00000019:3'],['Password','s00000019:4'],['Send','s00000019:5']]){
  await assert.rejects(ctl.execute('workspace_window_type',{...args,controlName,elementToken,requestId:'mmz-bad-'+controlName.replace(/ /g,'-')}),/WORKSPACE_EDITABLE_TARGET_UNVERIFIED/);
 }
 const receipt=await ctl.execute('workspace_window_type',args);
 assert.equal(receipt.decision.status,'CONFIRMED');
 assert.equal(calls.at(-1).name,'type_text');
 assert.deepEqual(calls.at(-1).args.target,{kind:'window',pid:id.pid,window_id:id.windowId});
 assert.equal(calls.at(-1).args.delivery_mode,'background');
 assert.equal(calls.at(-1).args.text,args.text);
 await assert.rejects(ctl.execute('workspace_window_type',args),/WORKSPACE_DUPLICATE_REQUEST_NO_REPLAY/);
});

test('uncertain typed input is one-shot and requires same-target journal reconciliation',async()=>{
 const calls=[];
 const ctl=makeController(async(name,args)=>{
  calls.push({name,args});
  if(name==='start_session')return {status:'ok'};
  if(name==='get_window_state')return {snapshot_id:'s0000001a',elements:[
   {role:'text',label:'Nonsecret test entry',actions:['SetFocus'],element_token:'s0000001a:1',enabled:true}]};
  if(name==='type_text')return {effect:'unverifiable',verified:false};
  if(name==='list_windows')return {windows:[{pid:32092,window_id:133238}]};
  throw new Error('UNEXPECTED_DRIVER_TOOL_'+name);
 });
 const id={pid:32092,windowId:133238};
 const arg={...id,controlName:'Nonsecret test entry',elementToken:'s0000001a:1',
  text:'SAFE_FIXTURE',requestId:'mmz-typed-uncertain-01',
  explicitUserAuthorization:'Owner approved only this private synthetic editable field'};
 await ctl.execute('workspace_window_observe',id);
 const effect=await ctl.execute('workspace_window_type',arg);
 assert.equal(effect.decision.status,'RECONCILE_TARGET');
 const fresh=await ctl.execute('workspace_window_observe',id);
 assert.equal(fresh.targetUncertain,true);
 await assert.rejects(ctl.execute('workspace_window_type',{...arg,requestId:'mmz-typed-uncertain-02'}),/WORKSPACE_TARGET_RECONCILIATION_REQUIRED/);
 const settled=await ctl.execute('workspace_target_reconcile',{...id,surface:'window',snapshotId:fresh.snapshotId,determination:'EFFECT_OBSERVED'});
 assert.equal(settled.ok,true);
 assert.equal((await ctl.execute('workspace_window_observe',id)).targetUncertain,false);
 assert.equal(calls.filter(c=>c.name==='type_text').length,1);
});

test('CUA driver path is owner-home pinned and ignores forged LOCALAPPDATA',async()=>{
  const os=(await import('node:os')).default;
  const path=(await import('node:path')).default;
  const {resolvePinnedWorkspaceDriverExecutable}=await import('../src/workspace-tools.mjs');
  assert.equal(typeof resolvePinnedWorkspaceDriverExecutable,'function');
  const win=path.win32.join(os.homedir(),'AppData','Local',
    'ChatGPTRemoteCommander','adapters','cua-driver','v0.38.0','cua-driver.exe');
  const linux=path.join(os.homedir(),'.local','share',
    'chatgpt-remote-commander','adapters','cua-driver','v0.38.0','cua-driver');
  assert.equal(resolvePinnedWorkspaceDriverExecutable('win32'),win);
  assert.equal(resolvePinnedWorkspaceDriverExecutable('linux'),linux);
  const prior=process.env.LOCALAPPDATA;
  try{
    for(const forged of ['Z:\\untrusted-executable-root','C:\\Users\\Other\\bin','..\\outside','']){
      process.env.LOCALAPPDATA=forged;
      assert.equal(resolvePinnedWorkspaceDriverExecutable('win32'),win);
    }
  }finally{
    if(prior===undefined)delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA=prior;
  }
  const source=await readFile(new URL('../src/workspace-tools.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/env\.LOCALAPPDATA/);
  assert.match(source,/const executable=resolvePinnedWorkspaceDriverExecutable\(platform\)/);
});