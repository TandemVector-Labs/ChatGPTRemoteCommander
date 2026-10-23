import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

test('Windows GUI incident folder may not escape via swapped junction ancestor', t => {
  if(process.platform!=='win32'){t.skip('Windows-only junction race');return;}
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rc-gui-winjunction-'));
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'rc-gui-outside-'));
  const ancestor=path.join(root,'safe');
  const privateDir=path.join(ancestor,'private');
  const sentinel=path.join(root,'intercept-fired');
  fs.mkdirSync(ancestor);
  const hook=path.join(root,'hook.cjs');
  fs.writeFileSync(hook,[
    "const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),mod=require('node:module');",
    "const original=fsp.mkdir;let once=false;",
    "fsp.mkdir=async function(name,...args){",
    "if(!once&&String(name)===process.env.RC_PRIVATE_DIR){once=true;fs.writeFileSync(process.env.RC_SENTINEL,'attempt');",
    "fs.renameSync(process.env.RC_ANCESTOR,process.env.RC_ANCESTOR+'.before');",
    "fs.symlinkSync(process.env.RC_EXTERNAL,process.env.RC_ANCESTOR,'junction');",
    "fs.writeFileSync(process.env.RC_SENTINEL,'intercept');",
    "}return original.call(this,name,...args);",
    "};mod.syncBuiltinESMExports();"
  ].join(String.fromCharCode(10)));
  const src=pathToFileURL(path.resolve('src/gui-incident-store.mjs')).href;
  const code="import {createGuiInputIncidentStore} from "+JSON.stringify(src)+";"+
    "try{await createGuiInputIncidentStore({file:process.env.RC_STORE_FILE}).begin('gui_mouse_click');console.log('BEGIN_SUCCEEDED')}catch(e){console.log(e.guiCode??e.code??e.message)}";
  try{
    const child=spawnSync(process.execPath,['--input-type=module','-e',code],{
      env:{...process.env,NODE_OPTIONS:'--require='+hook,RC_ANCESTOR:ancestor,RC_EXTERNAL:outside,
        RC_PRIVATE_DIR:privateDir,RC_SENTINEL:sentinel,RC_STORE_FILE:path.join(privateDir,'pending.json')},
      encoding:'utf8',timeout:10000
    });
    assert.equal(child.status,0,'child failed: '+child.stderr);
    assert.equal(fs.existsSync(sentinel),true,'race injection did not trigger');
    assert.equal(fs.existsSync(path.join(outside,'private')),false,'out-of-root incident evidence created');
  }finally{
    fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});
    fs.rmSync(outside,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  }
});
