import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runGuiProcess,createGuiProcessClient} from '../src/gui-process.mjs';
import {createGuiController} from '../src/gui-tools-windows.mjs';
import {createGuiInputIncidentStore} from '../src/gui-incident-store.mjs';

const fixture=fileURLToPath(new URL('./fixtures/gui-r536-mutex-receipt.mjs',import.meta.url));
const config={config:{powerMode:{enabled:true,guiControl:{enabled:true,allowScreenshot:true,allowMouse:true,allowKeyboard:true,allowWindowFocus:true}}}};
const image=()=>({ok:true,data:Buffer.from('89504e470d0a1a0a00000000','hex').toString('base64'),mimeType:'image/png',width:800,height:600,snapshot:{screenIndex:0,bounds:{left:0,top:0,width:800,height:600},foreground:'fixture-only',processId:33}});
async function withStore(run) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rc-r536-gui-mutex-'));
  try{return await run(path.join(root,'private-input.json'));}
  finally{await fs.rm(root,{recursive:true,force:true});}
}
const fake=(incidentStore,mutator)=>{
  let actions=0,closes=0;
  const c=createGuiController({platform:'win32',incidentStore,now:()=>1000,
    token:()=>String(++actions).padStart(48,'0'),isStopped:async()=>false,
    invoke:async request=>{
      if(request.action==='status')return {ok:true,available:true};
      if(request.action==='screenshot')return image();
      return mutator(request);
    },closeInvoke:()=>{closes++;}});
  return {run:(name,input={})=>c.execute(config,name,input),closes:()=>closes};
};
async function armed(c) {
  const s=await c.run('gui_session_begin',{mode:'takeover',explicitUserAuthorization:'Only in test fixture'});
  const pic=await c.run('gui_screenshot',{lease:s.lease});
  return {lease:s.lease,frame:pic.__structuredContent.frame};
}
test('one-shot helper recognizes only exact three-field pre-dispatch Windows mutex receipt',async()=>{
  await assert.rejects(runGuiProcess({action:'focusWindow'},{file:process.execPath,args:[fixture,'oneshot','valid'],timeoutMs:6000}),
    e=>e.guiCode==='GUI_NATIVE_BUSY' && e.guiNotApplied===true && e.guiWindowsMutexPreDispatch===true);
  for(const variant of ['missing','extra','forged','wrong']) {
    await assert.rejects(runGuiProcess({action:'focusWindow'},{file:process.execPath,args:[fixture,'oneshot',variant],timeoutMs:6000}),
      e=>e.guiNotApplied!==true && e.guiWindowsMutexPreDispatch!==true);
  }
});
test('persistent helper forwards exact no-dispatch proof without auto-replay',async()=>{
  const p=createGuiProcessClient({file:process.execPath,args:[fixture,'persistent','valid'],timeoutMs:6000,startupTimeoutMs:6000});
  try{
    await assert.rejects(p.invoke({action:'focusWindow'}),
      e=>e.guiCode==='GUI_NATIVE_BUSY'&&e.guiNotApplied===true&&e.guiWindowsMutexPreDispatch===true);
  }finally{p.close();}
});
test('J01 pending incident resolves only for typed Windows focus mutex receipt; lease/frame revoked',()=>withStore(async file=>{
  const store=createGuiInputIncidentStore({file});
  let calls=0;
  const c=fake(store,async()=>{calls++;return runGuiProcess({action:'focusWindow'},{file:process.execPath,args:[fixture,'oneshot','valid'],timeoutMs:6000});});
  const old=await armed(c);
  await assert.rejects(c.run('gui_focus_window',{...old,handle:'111'}),
    /GUI_NATIVE_BUSY/);
  assert.equal(calls,1);
  assert.equal(await store.pending(),null);
  const status=await c.run('gui_status');
  assert.equal(status.available,true);
  await assert.rejects(c.run('gui_screenshot',{lease:old.lease}),/GUI_LEASE_REQUIRED_OR_EXPIRED/);
  const newer=await c.run('gui_session_begin',{mode:'observe'});
  assert.notEqual(newer.lease,old.lease);
  assert.ok(c.closes()>=1);
}));
test('naked mutex busy cannot erase J01 incident or enable another input',()=>withStore(async file=>{
  const store=createGuiInputIncidentStore({file});
  let calls=0;
  const c=fake(store,async()=>{calls++;return runGuiProcess({action:'focusWindow'},{file:process.execPath,args:[fixture,'oneshot','missing'],timeoutMs:6000});});
  const old=await armed(c);
  await assert.rejects(c.run('gui_focus_window',{...old,handle:'111'}),/GUI_NATIVE_BUSY/);
  assert.equal(calls,1);
  assert.equal((await c.run('gui_status')).uncertain,true);
  assert.equal((await store.pending()).tool,'gui_focus_window');
  await assert.rejects(c.run('gui_screenshot',{lease:old.lease}),/GUI_LEASE_REQUIRED_OR_EXPIRED/);
  const readOnly=await c.run('gui_session_begin',{mode:'observe'});
  assert.equal(readOnly.mode,'observe');
  const shot=await c.run('gui_screenshot',{lease:readOnly.lease});
  await assert.rejects(c.run('gui_focus_window',
    {lease:readOnly.lease,frame:shot.__structuredContent.frame,handle:'111'}),/GUI_INCIDENT_REVIEW_REQUIRED/);
  assert.equal((await store.pending()).tool,'gui_focus_window');
  assert.equal(calls,1);
}));
test('forged JavaScript no-effect flag without exact native marker remains uncertain',()=>withStore(async file=>{
  const store=createGuiInputIncidentStore({file});
  const c=fake(store,async()=>{throw Object.assign(Error('GUI_NATIVE_BUSY'),{guiCode:'GUI_NATIVE_BUSY',guiNotApplied:true});});
  const old=await armed(c);
  await assert.rejects(c.run('gui_focus_window',{...old,handle:'111'}),/GUI_NATIVE_BUSY/);
  assert.equal((await c.run('gui_status')).uncertain,true);
  assert.equal((await store.pending()).tool,'gui_focus_window');
}));
test('Windows status failure never claims live desktop readiness',async()=>{
  let calls=0;
  const c=createGuiController({platform:'win32',isStopped:async()=>false,incidentStore:{pending:async()=>null},
    invoke:async()=>{calls++;return {ok:false,error:'GUI_NATIVE_BUSY',submission:'NOT_SUBMITTED'};}});
  await assert.rejects(c.execute(config,'gui_status',{}),/GUI_NATIVE_BUSY/);
  await assert.rejects(c.execute(config,'gui_session_begin',{mode:'observe'}),/GUI_NATIVE_BUSY/);
  assert.equal(calls,2);
});
