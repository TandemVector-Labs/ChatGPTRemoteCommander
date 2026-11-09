import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {mergeExplicitOwnerGuiPolicy} from '../src/owner-gui-policy.mjs';

const active = () => ({powerMode:{guiControl:{enabled:true,allowMouse:true,allowKeyboard:true}},runtimeState:'existing-runtime'});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(),'rc-owner-overlay-'));
const sample = (file) => ({ownerGuiDelegation:{enabled:true,port:48837,authFile:file}});

test('no owner policy stays absent despite Full Power and GUI enabled',()=>{
  const x=mergeExplicitOwnerGuiPolicy(active(),{powerMode:{enabled:true}});
  assert.equal(x.merged,false);
  assert.equal(x.config.ownerGuiDelegation,undefined);
});

test('explicit observe-only local policy preserves all unrelated active configuration',()=>{
  const root=tmp();
  try {
    const secret=path.join(root,'auth.key');fs.writeFileSync(secret,'a'.repeat(64),{mode:0o600});
    const baseline=active(),local=sample(secret);
    const x=mergeExplicitOwnerGuiPolicy(baseline,local);
    assert.equal(x.merged,true);
    assert.deepEqual(x.config.ownerGuiDelegation,{enabled:true,port:48837,authFile:secret});
    assert.equal(x.config.runtimeState,'existing-runtime');
    assert.equal(x.config.powerMode.guiControl.allowMouse,true);
    assert.equal(baseline.ownerGuiDelegation,undefined);
    assert.equal(local.ownerGuiDelegation.enabled,true);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('invalid or unauthorized policy fails closed before any overlay',()=>{
  const root=tmp();
  try {
    const key=path.join(root,'auth.key');fs.writeFileSync(key,'a'.repeat(64),{mode:0o600});
    const candidates=[
      {ownerGuiDelegation:{enabled:true,port:80,authFile:key}},
      {ownerGuiDelegation:{enabled:true,port:48837,authFile:'relative.txt'}},
      {ownerGuiDelegation:{enabled:true,port:48837,authFile:path.join(root,'absent.key')}},
      {ownerGuiDelegation:{enabled:true,port:48837,authFile:key,mode:'takeover'}},
      {ownerGuiDelegation:{enabled:false,authFile:key}}
    ];
    for(const c of candidates)assert.throws(()=>mergeExplicitOwnerGuiPolicy(active(),c),/OWNER_GUI_POLICY_/);
    const disabled=mergeExplicitOwnerGuiPolicy(active(),{ownerGuiDelegation:{enabled:false}});
    assert.deepEqual(disabled.config.ownerGuiDelegation,{enabled:false});
    assert.throws(()=>mergeExplicitOwnerGuiPolicy({powerMode:{guiControl:{enabled:false}}},sample(key)),/CORE_GUI_DISABLED/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('native primary policy merger transmits only opted-in observation fields',()=>{
  const root=tmp();
  try {
    const key=path.join(root,'auth.key');fs.writeFileSync(key,'a'.repeat(64),{mode:0o600});
    const af=path.join(root,'active.json'),lf=path.join(root,'local.json'),out=path.join(root,'merged.json');
    fs.writeFileSync(af,JSON.stringify(active()));
    fs.writeFileSync(lf,JSON.stringify(sample(key)));
    const run=spawnSync(process.execPath,['tools/merge-primary-policy.mjs','--active',af,'--local',lf,'--output',out],{encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);
    const receipt=JSON.parse(run.stdout);
    assert.equal(receipt.merged,true);
    assert.equal(receipt.status,'EXPLICIT_OWNER_GUI_POLICY');
    const merged=JSON.parse(fs.readFileSync(out));
    assert.deepEqual(merged.ownerGuiDelegation,{enabled:true,port:48837,authFile:key});
    assert.equal(merged.runtimeState,'existing-runtime');
    assert.ok(!JSON.stringify(receipt).includes('a'.repeat(64)));
    const bad=sample(key);bad.ownerGuiDelegation.mode='takeover';
    fs.writeFileSync(lf,JSON.stringify(bad));
    const reject=spawnSync(process.execPath,['tools/merge-primary-policy.mjs','--active',af,'--local',lf,'--output',out],{encoding:'utf8'});
    assert.notEqual(reject.status,0);
    assert.equal(JSON.parse(fs.readFileSync(out)).ownerGuiDelegation.authFile,key,'rejected mutation must preserve prior output');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
