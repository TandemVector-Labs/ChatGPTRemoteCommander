import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
test('Windows held guard blocks ancestor junction substitution before GUI guard file write',t=>{
 if(process.platform!=='win32'){t.skip('Windows only');return;}
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rc-guard-write-'));
 const external=fs.mkdtempSync(path.join(os.tmpdir(),'rc-guard-outside-'));
 const ancestor=path.join(root,'safe'),privateDir=path.join(ancestor,'private');
 const outsideDir=path.join(external,'private'),marker=path.join(root,'intercept-result');
 fs.mkdirSync(privateDir,{recursive:true});fs.mkdirSync(outsideDir,{recursive:true});
 const preload=path.join(root,'hook.cjs');
 fs.writeFileSync(preload,[
 "const fs=require('node:fs'),fsp=require('node:fs/promises'),mod=require('node:module');",
 "const old=fsp.open;let once=false;",
 "fsp.open=async function(file,...args){",
 "if(!once && String(file).endsWith('.exclusive-incident-v1')){once=true;",
 " try{fs.renameSync(process.env.RC_PARENT,process.env.RC_PARENT+'.before');",
 "     fs.symlinkSync(process.env.RC_OUTSIDE,process.env.RC_PARENT,'junction');",
 "     fs.writeFileSync(process.env.RC_MARK,'SWAPPED');",
 " }catch(e){fs.writeFileSync(process.env.RC_MARK,'DENIED_'+e.code);}",
 "}",
 "return old.call(this,file,...args);",
 "};mod.syncBuiltinESMExports();"
 ].join(String.fromCharCode(10)));
 const src=new URL('../src/gui-incident-store.mjs',import.meta.url).href;
 const exec="import {createGuiInputIncidentStore} from "+JSON.stringify(src)+";"+
  "try{await createGuiInputIncidentStore({file:process.env.RC_INCIDENT_FILE}).begin('gui_mouse_click');console.log('GUI_BEGIN_OK')}catch(e){console.log(e.guiCode||e.message)}";
 try{
  const r=spawnSync(process.execPath,['--input-type=module','-e',exec],{
   cwd:root,env:{...process.env,NODE_OPTIONS:'--require='+preload,
   RC_PARENT:ancestor,RC_OUTSIDE:external,RC_MARK:marker,RC_INCIDENT_FILE:path.join(privateDir,'pending.json')},
   encoding:'utf8',timeout:12000
  });
  assert.equal(r.status,0,r.stderr);
  assert.equal(fs.existsSync(marker),true,'guard write hook must trigger');
  assert.match(fs.readFileSync(marker,'utf8'),/^DENIED_/,'ancestor rename should fail before guard/file writes');
  assert.equal(fs.existsSync(path.join(outsideDir,'pending.json')),false,'no out-of-root incident state');
 }finally{fs.rmSync(root,{recursive:true,force:true,maxRetries:4,retryDelay:120});
 fs.rmSync(external,{recursive:true,force:true,maxRetries:4,retryDelay:120});}
});
