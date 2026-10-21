import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createGuiController} from '../src/gui-tools-windows.mjs';
import {createGuiInputIncidentStore} from '../src/gui-incident-store.mjs';

const ownFile=async(run)=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'rc-gui-incident-j01-'));
 const file=path.join(root,'gui-input-pending.json');
 try{return await run(file);}
 finally{await fs.rm(root,{recursive:true,force:true});}
};
const image=()=>({
  ok:true,data:Buffer.from('89504e470d0a1a0a00000000','hex').toString('base64'),
  mimeType:'image/png',width:800,height:600,
  snapshot:{screenIndex:0,bounds:{left:0,top:0,width:800,height:600},foreground:'test',processId:42}
});
const config={config:{powerMode:{enabled:true,guiControl:{
 enabled:true,allowScreenshot:true,allowMouse:true,allowKeyboard:true,allowWindowFocus:true
}}}};
function controller(incidentStore,{invoke=async(req)=>(req.action==='screenshot'?image():{ok:true,available:true}),platform='win32'}={}){
 let calls=0;
 const c=createGuiController({
  platform,incidentStore,token:()=>('a'.repeat(48)),isStopped:async()=>false,
  invoke:async req=>{calls++;return invoke(req);},closeInvoke:()=>{},
  now:()=>1000
 });
 return {run:(name,args={})=>c.execute(config,name,args),get calls(){return calls}};
}
async function takeover(c){
 const s=await c.run('gui_session_begin',{mode:'takeover',explicitUserAuthorization:'Disposable fixture permission'});
 const shot=await c.run('gui_screenshot',{lease:s.lease});
 return {lease:s.lease,frame:shot.__structuredContent.frame};
}
test('successful input creates minimum private evidence BEFORE dispatch and clears it on ack',()=>ownFile(async file=>{
 const store=createGuiInputIncidentStore({file});
 let seen;
 const c=controller(store,{invoke:async req=>{
  if(req.action==='status')return {ok:true,available:true};
  if(req.action==='screenshot')return image();
  seen=JSON.parse(await fs.readFile(file,'utf8'));
  return {ok:true};
 }});
 const a=await takeover(c);
 const out=await c.run('gui_key_press',{...a,keys:['A']});
 assert.equal(out.submitted,true);
 assert.equal(out.visualVerificationRequired,true);
 assert.equal(seen.tool,'gui_key_press');
 assert.equal(seen.status,'PENDING_NATIVE_EFFECT');
 assert.deepEqual(Object.keys(seen).sort(),['id','schema','startedUtc','status','tool']);
 await assert.rejects(fs.readFile(file),{code:'ENOENT'});
 assert.equal(await store.pending(),null);
}));
test('unknown native input persists across fresh controller and never replays',()=>ownFile(async file=>{
 const store=createGuiInputIncidentStore({file});
 const c=controller(store,{invoke:async req=>{
  if(req.action==='status')return {ok:true,available:true};
  if(req.action==='screenshot')return image();
  throw Error('GUI_SENDINPUT_FAILED secret-do-not-record');
 }});
 const a=await takeover(c);
 await assert.rejects(c.run('gui_type_text',{...a,text:'PRIVATE-INPUT-MUST-NOT-PERSIST'}),/GUI_SENDINPUT_FAILED/);
 const json=await fs.readFile(file,'utf8');
 assert.equal(json.includes('PRIVATE-INPUT'),false);
 assert.equal(json.includes('secret-do-not-record'),false);
 assert.equal(JSON.parse(json).tool,'gui_type_text');
 const fresh=controller(createGuiInputIncidentStore({file}));
 const status=await fresh.run('gui_status');
 assert.equal(status.uncertain,true);
 assert.equal(status.incidentPending,true);
 assert.equal(status.reason,'NATIVE_OUTCOME_UNCERTAIN_RESTART_REQUIRED');
 await assert.rejects(fresh.run('gui_session_begin',{mode:'observe'}),/GUI_OUTCOME_UNCERTAIN/);
 assert.equal(fresh.calls,0);
}));
test('strong Linux pre-dispatch no-effect proof clears pending evidence without replay',()=>ownFile(async file=>{
 const store=createGuiInputIncidentStore({file});
 let attempted=0;
 const c=controller(store,{platform:'linux',invoke:async req=>{
  if(req.action==='status')return {ok:true,available:true};
  if(req.action==='screenshot')return image();
  attempted++;
  throw Object.assign(new Error('GUI_FOREGROUND_OR_GEOMETRY_CHANGED'),{
   guiCode:'GUI_FOREGROUND_OR_GEOMETRY_CHANGED',guiNotApplied:true
  });
 }});
 const a=await takeover(c);
 await assert.rejects(c.run('gui_mouse_click',{...a,x:7,y:8}),/GUI_FOREGROUND_OR_GEOMETRY_CHANGED/);
 assert.equal(await store.pending(),null);
 assert.equal(attempted,1);
 assert.equal((await c.run('gui_status')).available,true);
 const again=await c.run('gui_session_begin',{mode:'observe'});
 assert.equal(again.mode,'observe');
}));
test('corrupt incident fails closed; GUI helper is never invoked',()=>ownFile(async file=>{
 await fs.writeFile(file,'not-a-valid-incident');
 const store=createGuiInputIncidentStore({file});
 const c=controller(store);
 const v=await c.run('gui_status');
 assert.equal(v.available,false);
 assert.equal(v.incidentStoreUnavailable,true);
 assert.equal(v.reason,'GUI_INCIDENT_STORAGE_UNAVAILABLE');
 await assert.rejects(c.run('gui_session_begin',{mode:'observe'}),/GUI_INCIDENT_STORAGE_UNAVAILABLE/);
 assert.equal(c.calls,0);
}));
test('wrong incident resolution identifier cannot erase a pending record',()=>ownFile(async file=>{
 const s=createGuiInputIncidentStore({file});
 const a=await s.begin('gui_mouse_click');
 await assert.rejects(s.resolve({...a,id:'different-id'}),/GUI_INCIDENT_RESOLUTION_MISMATCH/);
 assert.equal((await s.pending()).id,a.id);
 await s.resolve(a);
 assert.equal(await s.pending(),null);
}));
test('two processes cannot begin the same desktop input concurrently',()=>ownFile(async file=>{
 const x=createGuiInputIncidentStore({file}),y=createGuiInputIncidentStore({file});
 const [a,b]=await Promise.allSettled([x.begin('gui_mouse_click'),y.begin('gui_mouse_click')]);
 assert.equal([a,b].filter(z=>z.status==='fulfilled').length,1);
 assert.equal([a,b].filter(z=>z.status==='rejected').length,1);
 assert.ok(await x.pending());
}));
test('real child process termination leaves private pending evidence and blocks fresh controller',()=>ownFile(async file=>{
 const url=pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../src/gui-incident-store.mjs')).href;
 const script=[
  'import {createGuiInputIncidentStore} from '+JSON.stringify(url)+';',
  'const s=createGuiInputIncidentStore({file:process.argv.at(-1)});',
  "await s.begin('gui_mouse_click');",
  "process.kill(process.pid,'SIGKILL');"
 ].join('\n');
 const killed=spawnSync(process.execPath,['--input-type=module','-e',script,file],{
  encoding:'utf8',timeout:10000,windowsHide:true
 });
 assert.notEqual(killed.status,0);
 const fresh=controller(createGuiInputIncidentStore({file}));
 const status=await fresh.run('gui_status');
 assert.equal(status.available,false);
 assert.equal(status.uncertain,true);
 await assert.rejects(fresh.run('gui_session_begin',{mode:'observe'}),/GUI_OUTCOME_UNCERTAIN/);
 assert.equal(fresh.calls,0);
}));
test('read-only status and screenshot do not create a phantom incident',()=>ownFile(async file=>{
 const store=createGuiInputIncidentStore({file});
 const c=controller(store);
 const s=await c.run('gui_status');
 assert.equal(s.available,true);
 const begin=await c.run('gui_session_begin',{mode:'observe'});
 await c.run('gui_screenshot',{lease:begin.lease});
 assert.equal(await store.pending(),null);
 await assert.rejects(fs.lstat(file),{code:'ENOENT'});
}));
test('incident file mode is private on POSIX hosts',()=>ownFile(async file=>{
 const s=createGuiInputIncidentStore({file});
 const receipt=await s.begin('gui_key_press');
 const mode=(await fs.stat(file)).mode;
 if(process.platform!=='win32')assert.equal(mode&0o077,0);
 await s.resolve(receipt);
}));


test('pending record refuses symlinks and hardlinks instead of reading their targets',()=>ownFile(async file=>{
 const externalRoot=await fs.mkdtemp(path.join(os.tmpdir(),'rc-gui-incident-external-'));
 const external=path.join(externalRoot,'incident.json');
 try{
  await fs.writeFile(external,JSON.stringify({
   schema:'rc-gui-pending-input-v1',status:'PENDING_NATIVE_EFFECT',tool:'gui_mouse_click',
   id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',startedUtc:new Date().toISOString()
  }));
  await fs.link(external,file);
  const store=createGuiInputIncidentStore({file});
  await assert.rejects(store.pending(),/GUI_INCIDENT_STORAGE_UNAVAILABLE/);
  await fs.unlink(file);
  try{await fs.symlink(external,file,'file');}
  catch(e){if(['EPERM','EACCES','ENOTSUP'].includes(e.code))return;throw e;}
  await assert.rejects(store.pending(),/GUI_INCIDENT_STORAGE_UNAVAILABLE/);
  await fs.unlink(file);
  await fs.unlink(external);
  await fs.symlink(external,file,'file');
  await assert.rejects(store.pending(),/GUI_INCIDENT_STORAGE_UNAVAILABLE/,
   'a dangling incident symlink is unsafe, never evidence of no pending effect');
 }finally{await fs.rm(externalRoot,{recursive:true,force:true});}
}));

test('incident pending reads a verified file handle and refuses oversized records',()=>ownFile(async file=>{
 const s=createGuiInputIncidentStore({file});
 const h=await s.begin('gui_mouse_click');
 assert.equal((await s.pending()).id,h.id);
 await fs.appendFile(file,' '.repeat(2050));
 await assert.rejects(s.pending(),/GUI_INCIDENT_STORAGE_UNAVAILABLE/);
}));
