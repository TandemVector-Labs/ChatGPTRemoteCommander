import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
test('GUI incident store cannot create outside a symlink-swapped ancestor',t=>{
 if(process.platform!=='linux'){t.skip('Linux ancestor race fixture');return;}
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rc-gui-swap-'));
 const external=fs.mkdtempSync(path.join(os.tmpdir(),'rc-gui-external-'));
 const ancestor=path.join(root,'safe'),folder=path.join(ancestor,'private'),marker=path.join(root,'hook-fired');
 fs.mkdirSync(ancestor,{mode:0o700});
 const hook=path.join(root,'hook.cjs');
 fs.writeFileSync(hook,[
  "const fs=require('node:fs'),p=require('node:fs/promises'),m=require('node:module');",
  "const original=p.mkdir;let swapped=false;",
  "p.mkdir=async function(name,...args){",
  "if(!swapped&&require('node:path').basename(String(name))===require('node:path').basename(process.env.RC_GUI_FOLDER)){swapped=true;",
  "fs.renameSync(process.env.RC_GUI_ANCESTOR,process.env.RC_GUI_ANCESTOR+'.original');",
  "fs.symlinkSync(process.env.RC_GUI_EXTERNAL,process.env.RC_GUI_ANCESTOR,'dir');",
  "fs.writeFileSync(process.env.RC_GUI_MARK,'hook-fired');",
  "}return original.call(this,name,...args);",
  "};m.syncBuiltinESMExports();"
 ].join('\n'));
 const moduleUrl=pathToFileURL(path.resolve('src/gui-incident-store.mjs')).href;
 const code="import {createGuiInputIncidentStore} from "+JSON.stringify(moduleUrl)+";"+
 "try{await createGuiInputIncidentStore({file:process.env.RC_GUI_FILE}).begin('gui_mouse_click')}catch(e){console.error(e.guiCode??e.message)}";
 try{
  const result=spawnSync(process.execPath,['--input-type=module','-e',code],{
   env:{...process.env,NODE_OPTIONS:'--require='+hook,RC_GUI_FOLDER:folder,
    RC_GUI_ANCESTOR:ancestor,RC_GUI_EXTERNAL:external,
    RC_GUI_FILE:path.join(folder,'state.json'),RC_GUI_MARK:marker},
   encoding:'utf8',timeout:9000
  });
  assert.equal(fs.existsSync(marker),true,'reached post-preflight mkdir interception; '+result.stderr);
  assert.equal(fs.existsSync(path.join(external,'private')),false,
   'no directory may be created outside the private operator root');
 }finally{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(external,{recursive:true,force:true});}
});
