import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createWorkspaceTargetTools,workspaceTargetDefinitions,workspaceOwnerRequestContext} from '../src/workspace-target-tools.mjs';

function mock({windows=[{processId:333,handle:'444',title:'Science - Mozilla Firefox',wmClass:'firefox_firefox',focused:true}],allowInput=false}={}){
 const calls=[];
 const gui=async(name,args)=>{
  calls.push({name,args});
  switch(name){
   case 'gui_status':return {ok:true,available:true};
   case 'gui_session_begin':return {ok:true,lease:'private-lease',mode:args.mode};
   case 'gui_list_windows':return {ok:true,windows};
   case 'gui_session_end':return {ok:true};
   case 'gui_screenshot':return {ok:true,frame:'fresh-frame',bytes:12};
   case 'gui_focus_window':case 'gui_mouse_click':case 'gui_type_text':
    if(!allowInput)throw Error('GUI_TAKEOVER_NOT_AUTHORIZED');
    return {ok:true};
   default:throw Error('UNEXPECTED_GUI_TOOL_'+name);
  }
 };
 return {api:createWorkspaceTargetTools({gui}),calls};
}
test('existing Firefox discovery binds to owner window, not profile or WebDriver',async()=>{
 const {api,calls}=mock();
 const x=await api.execute('workspace_target_list',{application:'firefox'});
 assert.equal(x.windows.length,1);
 assert.deepEqual([x.windows[0].processId,x.windows[0].handle],[333,'444']);
 assert.equal(x.privateProfileAccess,false);
 assert.deepEqual(calls.map(x=>x.name),['gui_status','gui_session_begin','gui_list_windows','gui_session_end']);
 assert.equal(workspaceTargetDefinitions.some(x=>x.name==='workspace_target_type'),true);
});
test('a missing exact target never acquires continuing input authority',async()=>{
 const {api,calls}=mock();
 await assert.rejects(api.execute('workspace_target_open',{processId:333,handle:'999',mode:'observe'}),/WORKSPACE_TARGET_WINDOW_CHANGED_OR_MISSING/);
 assert.equal(calls.at(-1).name,'gui_session_end');
});
test('takeover requires explicit current-user authority even if the native GUI is ready',async()=>{
 const {api,calls}=mock();
 await assert.rejects(api.execute('workspace_target_open',{processId:333,handle:'444',mode:'takeover'}),/WORKSPACE_TARGET_AUTHORIZATION_REQUIRED/);
 assert.equal(calls.some(x=>x.name==='gui_session_begin'),false);
});
test('observe-only lease cannot click even when native backend would permit it',async()=>{
 const {api,calls}=mock({allowInput:true});
 const l=await api.execute('workspace_target_open',{processId:333,handle:'444',mode:'observe'});
 await assert.rejects(api.execute('workspace_target_click',{processId:333,handle:'444',lease:l.lease,frame:'fresh-frame',x:10,y:20}),/WORKSPACE_TARGET_TAKEOVER_REQUIRED/);
 assert.equal(calls.some(x=>x.name==='gui_mouse_click'),false);
});
test('stale or nonfocused windows fail closed before any input',async()=>{
 const {api,calls}=mock({windows:[{processId:333,handle:'444',focused:false}]});
 const l=await api.execute('workspace_target_open',{processId:333,handle:'444',mode:'takeover',explicitUserAuthorization:'Owner permits QA only'});
 await assert.rejects(api.execute('workspace_target_type',{processId:333,handle:'444',lease:l.lease,frame:'fresh-frame',text:'hello'}),/WORKSPACE_TARGET_FOCUS_NOT_CONFIRMED/);
 assert.equal(calls.some(x=>x.name==='gui_type_text'),false);
});
test('authorized exact target uses original native frame and lease without copying session',async()=>{
 const {api,calls}=mock({allowInput:true});
 const s=await api.execute('workspace_target_open',{processId:333,handle:'444',mode:'takeover',explicitUserAuthorization:'Approved one foreground action in current task'});
 assert.equal(s.source,'existing-owner-window');
 assert.equal(s.profileInherited,false);
 const image=await api.execute('workspace_target_snapshot',{processId:333,handle:'444',lease:s.lease});
 assert.equal(image.frame,'fresh-frame');
 const typed=await api.execute('workspace_target_type',{processId:333,handle:'444',lease:s.lease,frame:image.frame,text:'QA'});
 assert.equal(typed.ok,true);
 assert.deepEqual(calls.filter(x=>x.name==='gui_type_text').map(x=>x.args),[{lease:'private-lease',frame:'fresh-frame',text:'QA'}]);
});

test('lease is bound to exact pid and handle and cannot be reused on another window',async()=>{
 const windows=[{processId:333,handle:'444',focused:true},{processId:333,handle:'445',focused:true}];
 const {api,calls}=mock({windows,allowInput:true});
 const l=await api.execute('workspace_target_open',{processId:333,handle:'444',mode:'takeover',explicitUserAuthorization:'Owner permits specific QA target'});
 await assert.rejects(api.execute('workspace_target_type',{processId:333,handle:'445',lease:l.lease,frame:'fresh-frame',text:'not allowed'}),/WORKSPACE_TARGET_LEASE_TARGET_MISMATCH/);
 assert.equal(calls.some(x=>x.name==='gui_type_text'),false);
 const ended=await api.execute('workspace_target_end',{lease:l.lease});
 assert.equal(ended.ok,true);
 await assert.rejects(api.execute('workspace_target_snapshot',{processId:333,handle:'444',lease:l.lease}),/WORKSPACE_TARGET_LEASE_UNBOUND_OR_EXPIRED/);
});
test('one process-scoped lease registry persists across adapter instances but cannot be reused by outsiders',async()=>{
 const bindings=new Map(), calls=[];
 const gui=async(name,args)=>{calls.push(name);if(name==='gui_status')return {ok:true,available:true};if(name==='gui_session_begin')return {ok:true,lease:'shared-lease',mode:args.mode};if(name==='gui_list_windows')return {windows:[{processId:333,handle:'444',focused:true}]};if(name==='gui_session_end')return {ok:true};if(name==='gui_screenshot')return {ok:true,frame:'shared-frame'};throw Error('INVALID_TOOL');};
 const a=createWorkspaceTargetTools({gui,bindings});
 const b=createWorkspaceTargetTools({gui,bindings});
 const l=await a.execute('workspace_target_open',{processId:333,handle:'444',mode:'observe'});
 assert.equal((await b.execute('workspace_target_snapshot',{processId:333,handle:'444',lease:l.lease})).frame,'shared-frame');
 await assert.rejects(createWorkspaceTargetTools({gui}).execute('workspace_target_snapshot',{processId:333,handle:'444',lease:l.lease}),/WORKSPACE_TARGET_LEASE_UNBOUND_OR_EXPIRED/);
});

test('owner read-only list derives a distinct bounded request ID for delegated observe lease',()=>{
 const one=workspaceOwnerRequestContext({}, {},()=> '11111111-1111-4111-8111-111111111111');
 const two=workspaceOwnerRequestContext({}, {},()=> '22222222-2222-4222-8222-222222222222');
 assert.equal(one.requestId,'workspace-11111111-1111-4111-8111-111111111111');
 assert.notEqual(one.requestId,two.requestId);
});
test('owner delegated mutation preserves existing receipt ID and rejects invalid IDs',()=>{
 const v=workspaceOwnerRequestContext({requestId:'stable-native-request-1'}, {requestId:'different-id'});
 assert.equal(v.requestId,'stable-native-request-1');
 assert.deepEqual(workspaceOwnerRequestContext({}, {requestId:'provided-rpc-call'}),{requestId:'provided-rpc-call'});
 assert.throws(()=>workspaceOwnerRequestContext({}, {},()=> 'invalid request id'),/WORKSPACE_TARGET_REQUEST_ID_INVALID/);
});

test('Windows PascalCase owner GUI windows normalize to exact identity without guessing executable from title',async()=>{
 const windows=[{Handle:'6291479',ProcessId:3184,Title:'Existing owner tab',Focused:false},{Handle:6291481,ProcessId:3185,Title:'Firefox - title only'}];
 const {api,calls}=mock({windows});
 const all=await api.execute('workspace_target_list',{application:'all'});
 assert.equal(all.windows.length,2);
 assert.deepEqual(all.windows.map(w=>[w.processId,w.handle]),[[3184,'6291479'],[3185,'6291481']]);
 assert.equal(all.windows[0].focused,false);
 const firefox=await api.execute('workspace_target_list',{application:'firefox'});
 assert.equal(firefox.windows.length,0,'titles must not be used as executable identity');
 const l=await api.execute('workspace_target_open',{processId:3184,handle:'6291479',mode:'observe'});
 assert.equal(l.processId,3184);
 await api.execute('workspace_target_end',{lease:l.lease});
 assert.equal(calls.at(-1).name,'gui_session_end');
});
test('Windows executable metadata can identify Firefox without launching or copying its profile',async()=>{
 const {api}=mock({windows:[{Handle:'5080',ProcessId:2100,ProcessName:'firefox.exe',Title:'Research',Focused:false},{Handle:'5081',ProcessId:2101,ProcessName:'brave.exe',Title:'Firefox is great'}]});
 const r=await api.execute('workspace_target_list',{application:'firefox'});
 assert.deepEqual(r.windows.map(w=>[w.processId,w.handle]),[[2100,'5080']]);
});
test('native observe-only lease cannot be relabeled as takeover by Workspace adapter',async()=>{
 const calls=[];
 const gui=async(name,args)=>{
  calls.push(name);
  if(name==='gui_status')return {ok:true,available:true};
  if(name==='gui_session_begin')return {ok:true,lease:'native-observe-only',mode:'observe'};
  if(name==='gui_session_end')return {ok:true};
  if(name==='gui_list_windows')return {windows:[{processId:9,handle:'200',focused:true}]};
  throw Error('unexpected '+name);
 };
 const api=createWorkspaceTargetTools({gui,bindings:new Map()});
 await assert.rejects(api.execute('workspace_target_open',{processId:9,handle:'200',mode:'takeover',explicitUserAuthorization:'Owner approved test action'}),/WORKSPACE_TARGET_MODE_NOT_GRANTED/);
 assert.deepEqual(calls,['gui_status','gui_session_begin','gui_session_end']);
});

test('Windows native read-only discovery reports OS process identity and foreground HWND',()=>{
 const helper=readFileSync(new URL('../tools/gui-control.ps1',import.meta.url),'utf8');
 assert.match(helper,/\$foreground=\[RcGuiNative\]::Foreground\(\)/);
 assert.match(helper,/Get-Process -Id \$processId -ErrorAction Stop/);
 assert.match(helper,/ProcessName=\$names\[\$key\]/);
 assert.match(helper,/Focused=\(\[string\]\$entry\.Handle -ceq \$foreground\)/);
 assert.match(helper,/catch \{ \} # A protected\/exiting process never gains a guessed name\./);
});

test('GNOME dual-screen Firefox snapshot follows exact owning monitor, not default desktop',async()=>{
 const bounds={left:1920,top:35,width:1900,height:1035};
 const window={processId:333,handle:'444',title:'Owner Firefox',wmClass:'firefox_firefox',
   focused:true,screenIndex:1,bounds};
 const calls=[];
 const gui=async(name,args)=>{
  calls.push({name,args});
  if(name==='gui_status')return {ok:true,available:true,screens:[
    {index:0,left:0,top:0,width:1920,height:1080},{index:1,left:1920,top:0,width:1920,height:1080}]};
  if(name==='gui_session_begin')return {ok:true,lease:'monitor-lease',mode:args.mode};
  if(name==='gui_list_windows')return {ok:true,windows:[window]};
  if(name==='gui_screenshot')return {ok:true,frame:'monitor-1-frame',screenIndex:args.screenIndex};
  if(name==='gui_focus_window'||name==='gui_mouse_click'||name==='gui_type_text')return {ok:true};
  if(name==='gui_session_end')return {ok:true};
  throw Error('UNEXPECTED_'+name);
 };
 const api=createWorkspaceTargetTools({gui});
 const list=await api.execute('workspace_target_list',{application:'firefox'});
 assert.equal(list.windows[0].screenIndex,1);
 assert.deepEqual(list.windows[0].bounds,bounds);
 const open=await api.execute('workspace_target_open',{processId:333,handle:'444',mode:'takeover',explicitUserAuthorization:'Owner P12 verification'});
 const shot=await api.execute('workspace_target_snapshot',{processId:333,handle:'444',lease:open.lease});
 assert.equal(shot.frame,'monitor-1-frame');
 assert.equal(calls.find(x=>x.name==='gui_screenshot').args.screenIndex,1);
 await assert.rejects(api.execute('workspace_target_click',
   {processId:333,handle:'444',lease:open.lease,frame:shot.frame,x:300,y:500}),
   /WORKSPACE_TARGET_POINT_OUTSIDE_TARGET_WINDOW/);
 assert.equal(calls.filter(x=>x.name==='gui_mouse_click').length,0);
 assert.equal((await api.execute('workspace_target_click',
   {processId:333,handle:'444',lease:open.lease,frame:shot.frame,x:2200,y:500})).ok,true);
 window.screenIndex=0;
 await assert.rejects(api.execute('workspace_target_type',
   {processId:333,handle:'444',lease:open.lease,frame:shot.frame,text:'NEVER'}),
   /WORKSPACE_TARGET_WINDOW_MOVED_MONITOR/);
 assert.equal(calls.filter(x=>x.name==='gui_type_text').length,0);
 assert.equal((await api.execute('workspace_target_end',{lease:open.lease})).ok,true);
});

test('multi-monitor target with unverified window monitor fails closed before input',async()=>{
 const calls=[];
 const gui=async(name,args)=>{
  calls.push(name);
  if(name==='gui_status')return {ok:true,available:true,screens:[{index:0},{index:1}]};
  if(name==='gui_session_begin')return {ok:true,lease:'fail-closed',mode:args.mode};
  if(name==='gui_list_windows')return {ok:true,windows:[{processId:333,handle:'444',focused:true}]};
  if(name==='gui_session_end')return {ok:true};
  throw Error('MUTATION_MUST_NOT_RUN');
 };
 const api=createWorkspaceTargetTools({gui});
 await assert.rejects(api.execute('workspace_target_open',{processId:333,handle:'444',
   mode:'takeover',explicitUserAuthorization:'Owner P12 verification'}),
   /WORKSPACE_TARGET_TARGET_MONITOR_UNVERIFIED/);
 assert.equal(calls.at(-1),'gui_session_end');
 assert.equal(calls.includes('gui_screenshot'),false);
});
