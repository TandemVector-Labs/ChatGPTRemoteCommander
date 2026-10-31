import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {catalog,validateCatalog,createPlan,parseArgs} from '../tools/installer-product-plan.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('catalog is explicit about platform availability and experimental product status',()=>{
  validateCatalog();
  assert.equal(catalog.schema,1);
  assert.deepEqual(catalog.products.map(p=>p.id),['core','control-center','browser','work-plugin','companion']);
  assert.equal(catalog.products.find(p=>p.id==='browser').platforms.linux.status,'conditional');
  assert.equal(catalog.products.find(p=>p.id==='control-center').platforms.linux.status,'unavailable');
  assert.equal(catalog.products.find(p=>p.id==='companion').platforms.windows.status,'unavailable');
});
test('Linux install all selects only available Core and deferred plugin, not unqualified standalone products',()=>{
  const p=createPlan({platform:'linux',all:true});
  assert.deepEqual(p.installNow,['core']);
  assert.deepEqual(p.pendingActivation,['work-plugin']);
  assert.ok(!p.installNow.includes('browser'));
  assert.ok(p.unavailable.includes('control-center'));
  assert.equal(p.changesApplied,false);
});
test('Windows install all includes Browser only when setup payload is bundled',()=>{
  assert.deepEqual(createPlan({platform:'windows',all:true}).installNow,['core','control-center']);
  assert.deepEqual(createPlan({platform:'windows',all:true,browserBundled:true}).installNow,['core','control-center','browser']);
  assert.deepEqual(createPlan({platform:'linux',all:true,browserBundled:true}).installNow,['core','browser']);
  assert.deepEqual(createPlan({platform:'linux',products:['browser'],browserBundled:true}).installNow,['core','browser']);
});
test('selection includes dependencies without silently granting Power Mode',()=>{
  const p=createPlan({platform:'windows',products:['control-center']});
  assert.deepEqual(p.installNow,['core','control-center']);
  assert.deepEqual(createPlan({platform:'linux',products:['work-plugin']}).pendingActivation,['work-plugin']);
  assert.deepEqual(createPlan({platform:'linux',products:['work-plugin']}).installNow,['core']);
  assert.equal(JSON.stringify(p).includes('PowerMode'),false);
});
test('unsupported, unavailable, unbundled, malformed and conflicting input fails before any installation',()=>{
  for(const call of [
    ()=>createPlan({platform:'linux',products:['browser']}),
    ()=>createPlan({platform:'linux',products:['control-center']}),
    ()=>createPlan({platform:'windows',products:['browser']}),
    ()=>createPlan({platform:'windows',products:['companion']}),
    ()=>createPlan({platform:'windows',products:['unknown']}),
    ()=>createPlan({platform:'linux',products:['core','core']}),
    ()=>createPlan({platform:'linux',all:true,products:['core']}),
    ()=>createPlan({platform:'darwin'}),
    ()=>parseArgs(['--platform','linux','--unsafe'])
  ])assert.throws(call);
});
test('catalog dependency cycles are refused',()=>{
 const clone=structuredClone(catalog);clone.products.find(p=>p.id==='core').requires=['work-plugin'];
 assert.throws(()=>validateCatalog(clone),/CYCLIC_DEPENDENCY/);
});
test('CLI list and plan are bounded read-only output, with exact Linux/Windows contract',()=>{
  const file=path.join(root,'tools/installer-product-plan.mjs');
  const cli=(...args)=>spawnSync(process.execPath,[file,...args],{encoding:'utf8',timeout:5000});
  let p=cli('--platform','linux','--all','--json');assert.equal(p.status,0,p.stderr);
  const plan=JSON.parse(p.stdout);assert.equal(plan.changesApplied,false);assert.deepEqual(plan.installNow,['core']);
  p=cli('--platform','windows','--list-products','--json');assert.equal(p.status,0,p.stderr);
  assert.equal(JSON.parse(p.stdout).products.length,5);
  p=cli('--platform','linux','--product','browser');assert.equal(p.status,2);assert.match(p.stderr,/PRODUCT_(UNAVAILABLE|NEEDS_QUALIFIED_PAYLOAD)/);
});
test('Windows installer components and Linux Bash wizard keep exact catalog scope',()=>{
  const iss=fs.readFileSync(path.join(root,'installer/RemoteCommander.iss'),'utf8');
  const sh=fs.readFileSync(path.join(root,'setup-wizard.sh'),'utf8');
  for(const x of ['Name: "core"','Name: "controlmonitor"','Name: "browser"','Name: "workplugin"'])assert.ok(iss.includes(x),x);
  for(const x of ['--list-products','--plan-only','--product','--all','PRODUCT_UNAVAILABLE'])assert.ok(sh.includes(x),x);
  assert.equal(iss.includes('Name: "companion"'),false);
});

test('Linux wizard offline read-only listing, plan mode and invalid selection have no side effects', {skip:process.platform==='win32'},()=>{
  const wizard=path.join(root,'setup-wizard.sh');
  const env={...process.env,HOME:'/tmp/rc-product-plan-unwritten-home',XDG_STATE_HOME:'/tmp/rc-product-plan-unwritten-state',DISPLAY:'',WAYLAND_DISPLAY:''};
  const run=(...args)=>spawnSync('bash',[wizard,...args],{env,encoding:'utf8',timeout:3500});
  let r=run('--list-products');assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/browser\s+conditional/);
  r=run('--plan-only','--all');assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/INSTALL_PLAN platform=linux selected=core,work-plugin changesApplied=false/);
  r=run('--plan-only','--product','core');assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/selected=core /);
  r=run('--plan-only','--skip-plugin');assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/selected=core /);
  for(const args of [
    ['--plan-only','--product','browser','--product','browser'],
    ['--plan-only','--product','control-center'],
    ['--plan-only','--product','companion'],
    ['--plan-only','--product','unknown'],
    ['--plan-only','--all','--product','core'],
    ['--plan-only','--all','--skip-plugin'],
    ['--plan-only','--product','work-plugin','--skip-plugin']
  ]){r=run(...args);assert.equal(r.status,2,JSON.stringify({args,stderr:r.stderr}));}
});

test('Linux GUI product selector honors optional selection and rejects cancellation without mutation', {skip:process.platform==='win32'},()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rc-product-zenity-'));
 try {
   const binary=path.join(dir,'zenity');
   fs.writeFileSync(binary,'#!/usr/bin/env bash\nif [[ "\${RC_ZENITY_CANCEL:-0}" == 1 ]]; then exit 1; fi\nprintf "%s\\n" "\${RC_ZENITY_RESULT-work-plugin}"\n',{mode:0o755});
   const pathVar=dir+path.delimiter+process.env.PATH;
   const run=(result,cancel=false)=>spawnSync('bash',[path.join(root,'setup-wizard.sh'),'--plan-only'],{
     encoding:'utf8',timeout:3500,
     env:{...process.env,PATH:pathVar,DISPLAY:':190',WAYLAND_DISPLAY:'',RC_ZENITY_RESULT:result,RC_ZENITY_CANCEL:cancel?'1':'0'}
   });
   let a=run('work-plugin');assert.equal(a.status,0,a.stderr);assert.match(a.stdout,/selected=core,work-plugin changesApplied=false/);
   a=run('browser');assert.equal(a.status,0,a.stderr);assert.match(a.stdout,/selected=core,browser changesApplied=false/);
   a=run('work-plugin|browser');assert.equal(a.status,0,a.stderr);assert.match(a.stdout,/selected=core,work-plugin,browser changesApplied=false/);
   a=run('');assert.equal(a.status,0,a.stderr);assert.match(a.stdout,/selected=core changesApplied=false/);
   a=run('work-plugin',true);assert.equal(a.status,2);assert.match(a.stderr,/GUI_PRODUCT_SELECTION_CANCELLED/);
   a=run('companion');assert.equal(a.status,2);assert.match(a.stderr,/INVALID_GUI_PRODUCT_SELECTION/);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('Linux Browser selection requires bundled helper, reports online prerequisites and never runs install in plan mode', {skip:process.platform==='win32'},()=>{
 const run=(...args)=>spawnSync('bash',[path.join(root,'setup-wizard.sh'),...args],{encoding:'utf8',timeout:3500,env:{...process.env,DISPLAY:'',WAYLAND_DISPLAY:''}});
 let p=run('--plan-only','--product','browser');
 assert.equal(p.status,0,p.stderr);
 assert.match(p.stdout,/selected=core,browser changesApplied=false/);
 assert.match(p.stdout,/BROWSER_REQUIRES_LINUX_X86_64_X11_INTERACTIVE_SUDO_ONLINE_367MB/);
 p=run('--plan-only','--all');assert.equal(p.status,0,p.stderr);
 assert.doesNotMatch(p.stdout,/selected=.*browser/);
 p=run('--plan-only','--all','--product','browser');assert.equal(p.status,2);
});

test('Linux Browser refuses unsupported real install before all Core mutations', {skip:process.platform==='win32'},()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rc-browser-prereq-'));
 try{
   const r=spawnSync('bash',[path.join(root,'setup-wizard.sh'),'--product','browser','--skip-install'],{
     encoding:'utf8',timeout:3500,env:{...process.env,HOME:temp,XDG_STATE_HOME:path.join(temp,'state'),DISPLAY:'',WAYLAND_DISPLAY:''}
   });
   assert.equal(r.status,2,r.stderr);
   assert.match(r.stderr,/BROWSER_LINUX_X11_REQUIRED|BROWSER_LINUX_UNSUPPORTED_ARCH/);
   assert.equal(fs.existsSync(path.join(temp,'state')),false,'No user-state directory may be created');
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
