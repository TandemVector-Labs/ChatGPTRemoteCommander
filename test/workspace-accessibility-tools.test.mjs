import test from 'node:test';
import assert from 'node:assert/strict';
import {
 createWorkspaceAccessibilityTools,workspaceAccessibilityDefinitions
} from '../src/workspace-accessibility-tools.mjs';

const OWNER={processId:10369,handle:'4205340062'};
const make=()=>{
 const calls=[];
 let title='IEEE Xplore: Advanced Search — Mozilla Firefox';
 let focused=true;
 let activeLease=0;
 let now=1000;
 const gui=async(name,args)=>{
  calls.push({name,args});
  if(name==='gui_status')return {ok:true,available:true,screens:[{index:0},{index:1}]};
  if(name==='gui_session_begin')return {ok:true,lease:'lease-'+(++activeLease),mode:args.mode};
  if(name==='gui_list_windows')return {ok:true,windows:[{...OWNER,title,wmClass:'firefox_firefox',focused}]};
  if(name==='gui_session_end')return {ok:true};
  throw Error('COORDINATE_METHOD_FORBIDDEN_'+name);
 };
 const transport=async r=>{
  calls.push({name:'atspi',args:r});
  assert.equal(r.pid,10369);
  assert.equal(r.windowTitle,title);
  if(r.command==='snapshot')return {ok:true,nodesVisited:22,truncated:false,controls:[
   {path:[0,2],role:'entry',name:'Search query',editable:true,action:null},
   {path:[0,4],role:'button',name:'Search',editable:false,action:'click'}
  ]};
  if(r.command==='type')return {ok:true,effect:'DISPATCHED'};
  if(r.command==='invoke')return {ok:true,effect:'DISPATCHED'};
  throw Error('UNKNOWN_ATSPI_OP');
 };
 const sessions=new Map(),api=createWorkspaceAccessibilityTools({gui,transport,sessions,now:()=>now});
 return {api,calls,sessions,setFocused:x=>focused=x,setTitle:x=>title=x,advance:x=>now+=x};
};

test('AT-SPI semantic route offers only independent non-coordinate tools',()=>{
 const names=workspaceAccessibilityDefinitions.map(x=>x.name);
 assert.deepEqual(names,[
  'workspace_accessibility_open','workspace_accessibility_snapshot',
  'workspace_accessibility_type','workspace_accessibility_invoke','workspace_accessibility_end'
 ]);
 for(const item of workspaceAccessibilityDefinitions){
  assert.equal(item.inputSchema.additionalProperties,false);
  assert.equal(item.name.includes('click'),false);
  assert.equal(item.name.includes('mouse'),false);
 }
});

test('owner observes controls but cannot mutate with observe-only lease',async()=>{
 const m=make();
 const l=await m.api.execute('workspace_accessibility_open',{...OWNER,mode:'observe'});
 assert.equal(l.semanticOnly,true);
 const snap=await m.api.execute('workspace_accessibility_snapshot',{...OWNER,lease:l.lease});
 assert.equal(snap.controls.length,2);
 assert.equal(snap.valuesRead,false);
 await assert.rejects(m.api.execute('workspace_accessibility_type',{
  ...OWNER,lease:l.lease,elementId:snap.controls[0].elementId,text:'TEST'
 }),/WORKSPACE_ACCESSIBILITY_TAKEOVER_REQUIRED/);
 assert.equal((await m.api.execute('workspace_accessibility_end',{lease:l.lease})).ok,true);
 assert.equal(m.calls.filter(x=>x.name==='atspi').length,1);
});

test('one-shot authorized semantic text + click with exact PID/HWND, no pointer',async()=>{
 const m=make();
 const l=await m.api.execute('workspace_accessibility_open',{
  ...OWNER,mode:'takeover',explicitUserAuthorization:'Owner accepts AT-SPI on existing Firefox only'
 });
 const controls=(await m.api.execute('workspace_accessibility_snapshot',{...OWNER,lease:l.lease})).controls;
 const typed=await m.api.execute('workspace_accessibility_type',{...OWNER,lease:l.lease,
  elementId:controls[0].elementId,text:'RC011_QUERY_QA'});
 assert.equal(typed.ok,true);
 await assert.rejects(m.api.execute('workspace_accessibility_type',{...OWNER,lease:l.lease,
  elementId:controls[0].elementId,text:'DUPLICATE'}),/ELEMENT_STALE_OR_UNBOUND/);
 const clicked=await m.api.execute('workspace_accessibility_invoke',{...OWNER,lease:l.lease,
  elementId:controls[1].elementId});
 assert.equal(clicked.effect,'DISPATCHED');
 assert.equal(m.calls.some(c=>c.name.includes('mouse')||c.name.includes('gui_type_text')),false);
 await m.api.execute('workspace_accessibility_end',{lease:l.lease});
 assert.equal(m.sessions.size,0);
});

test('focused owner window required at action time',async()=>{
 const m=make();const l=await m.api.execute('workspace_accessibility_open',{...OWNER,mode:'takeover',
  explicitUserAuthorization:'Current owner permits P12 semantic controls'});
 const f=(await m.api.execute('workspace_accessibility_snapshot',{...OWNER,lease:l.lease})).controls[0];
 m.setFocused(false);
 await assert.rejects(m.api.execute('workspace_accessibility_type',{...OWNER,
  lease:l.lease,elementId:f.elementId,text:'NEVER'}),/FOCUS_NOT_CONFIRMED/);
 assert.equal(m.calls.filter(c=>c.name==='atspi'&&c.args.command==='type').length,0);
 await m.api.execute('workspace_accessibility_end',{lease:l.lease});
});

test('window title change refuses new actions',async()=>{
 const m=make();const l=await m.api.execute('workspace_accessibility_open',{...OWNER,mode:'takeover',
  explicitUserAuthorization:'Current owner permits P12 semantic controls'});
 const item=(await m.api.execute('workspace_accessibility_snapshot',{...OWNER,lease:l.lease})).controls[1];
 m.setTitle('Different page — Mozilla Firefox');
 await assert.rejects(m.api.execute('workspace_accessibility_invoke',{...OWNER,
  lease:l.lease,elementId:item.elementId}),/OWNER_BROWSER_CHANGED/);
 assert.equal(m.calls.filter(c=>c.name==='atspi'&&c.args.command==='invoke').length,0);
 await m.api.execute('workspace_accessibility_end',{lease:l.lease});
});

test('expired element and wrong PID refuse without native mutation',async()=>{
 const m=make();const l=await m.api.execute('workspace_accessibility_open',{...OWNER,mode:'takeover',
  explicitUserAuthorization:'Current owner permits P12 semantic controls'});
 const item=(await m.api.execute('workspace_accessibility_snapshot',{...OWNER,lease:l.lease})).controls[1];
 await assert.rejects(m.api.execute('workspace_accessibility_invoke',{...OWNER,
  processId:4321,lease:l.lease,elementId:item.elementId}),/LEASE_UNBOUND/);
 m.advance(20001);
 await assert.rejects(m.api.execute('workspace_accessibility_invoke',{...OWNER,
  lease:l.lease,elementId:item.elementId}),/ELEMENT_STALE_OR_UNBOUND/);
 assert.equal(m.calls.filter(c=>c.name==='atspi'&&c.args.command==='invoke').length,0);
 await m.api.execute('workspace_accessibility_end',{lease:l.lease});
});

test('authorization and capability assumptions enforced before lease',async()=>{
 const m=make();
 await assert.rejects(m.api.execute('workspace_accessibility_open',{...OWNER,mode:'takeover'}),
 /AUTHORIZATION_REQUIRED/);
 await assert.rejects(m.api.execute('workspace_accessibility_open',{
  processId:0,handle:'invalid',mode:'observe'}),/IDENTITY_INVALID/);
 assert.equal(m.calls.filter(c=>c.name==='gui_session_begin').length,0);
});

import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('native AT-SPI helper checks real UID, denies cross-user and missing process before GUI tree access',()=>{
 const helper=fileURLToPath(new URL('../tools/owner-atspi-semantic.py',import.meta.url));
 const program="import ast,os,sys,types\nsrc=open(sys.argv[1],encoding='utf8').read()\nmodule=ast.parse(src)\nfn=next(n for n in module.body if isinstance(n,ast.FunctionDef) and n.name=='assert_owner_pid')\nscope={'os':os,'fail':lambda code: (_ for _ in ()).throw(ValueError(code))}\nexec(compile(ast.Module(body=[fn],type_ignores=[]),sys.argv[1],'exec'),scope)\nassert scope['assert_owner_pid'](os.getpid()) is None\nscope['os']=types.SimpleNamespace(geteuid=os.geteuid,stat=lambda _:types.SimpleNamespace(st_uid=os.geteuid()+1))\ntry: scope['assert_owner_pid'](os.getpid())\nexcept ValueError as e: assert str(e)=='OWNER_UID_MISMATCH'\nelse: raise AssertionError('CROSS_USER_NOT_REFUSED')\ndef gone(_): raise FileNotFoundError()\nscope['os']=types.SimpleNamespace(geteuid=os.geteuid,stat=gone)\ntry: scope['assert_owner_pid'](99999999)\nexcept ValueError as e: assert str(e)=='OWNER_PID_UNAVAILABLE'\nelse: raise AssertionError('MISSING_PROCESS_NOT_REFUSED')\nprint('AT_SPI_OWNER_UID_VALIDATION_PASS')";
 const result=spawnSync('/usr/bin/python3',['-c',program,helper],{encoding:'utf8',timeout:5000});
 assert.equal(result.status,0,result.stderr||result.stdout);
 assert.match(result.stdout,/AT_SPI_OWNER_UID_VALIDATION_PASS/);
});


test('existing Brave owner GUI is accepted semantically without CDP or credentials',async()=>{
 let observed=0;
 const gui=async(name,args)=>{
  if(name==='gui_status')return {ok:true,available:true};
  if(name==='gui_session_begin')return {ok:true,lease:'brave-owner-lease',mode:args.mode};
  if(name==='gui_list_windows')return {ok:true,windows:[{processId:7711,handle:'5599',wmClass:'brave-browser',title:'Project — Brave Browser',focused:true}]};
  if(name==='gui_session_end')return {ok:true};
  throw Error('UNEXPECTED_'+name);
 };
 const transport=async x=>{
  observed++;
  assert.equal(x.command,'snapshot');assert.equal(x.pid,7711);
  return {ok:true,controls:[{path:[0,1],role:'push button',name:'New chat',editable:false,action:'click'}],nodesVisited:5,truncated:false};
 };
 const ctl=createWorkspaceAccessibilityTools({gui,transport});
 const a=await ctl.execute('workspace_accessibility_open',{processId:7711,handle:'5599',mode:'observe'});
 const b=await ctl.execute('workspace_accessibility_snapshot',{processId:7711,handle:'5599',lease:a.lease});
 assert.equal(b.controls.length,1);assert.equal(observed,1);
 assert.equal(b.valuesRead,false);assert.equal(b.semanticOnly,true);
 await ctl.execute('workspace_accessibility_end',{lease:a.lease});
});
test('unrecognized same-session app cannot impersonate browser semantic route',async()=>{
 const gui=async(name,args)=>{
  if(name==='gui_status')return {ok:true,available:true};
  if(name==='gui_session_begin')return {ok:true,lease:'unrelated-lease',mode:args.mode};
  if(name==='gui_list_windows')return {ok:true,windows:[{processId:7711,handle:'5599',wmClass:'random-app',title:'Project — Browser',focused:true}]};
  if(name==='gui_session_end')return {ok:true};
 };
 const ctl=createWorkspaceAccessibilityTools({gui,transport:async()=>{throw Error('MUST_NOT_REACH_TRANSPORT')}});
 await assert.rejects(ctl.execute('workspace_accessibility_open',{processId:7711,handle:'5599',mode:'observe'}),/OWNER_BROWSER_UNVERIFIED/);
});
