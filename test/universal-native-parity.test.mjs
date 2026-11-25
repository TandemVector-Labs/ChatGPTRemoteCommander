import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tool=path.join(root,'tools/universal-install/verify-native-parity.mjs');
const SHA='a'.repeat(40);
function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rc012-native-compare-'));
  const list={};
  for(let i=0;i<101;i++)list['src/entry-'+String(i).padStart(3,'0')+'.mjs']='f'.repeat(64);
  for(const p of ['package.json','config.json','src/server-v0.3.mjs','src/browser-tools.mjs',
    'src/workflow-tools.mjs','src/transfer-tools.mjs'])list[p]='e'.repeat(64);
  const input={schema:2,head:SHA,tree:'b'.repeat(40),count:Object.keys(list).length,files:list};
  const w=path.join(dir,'windows.json'),l=path.join(dir,'linux.json');
  const save=(p,v)=>fs.writeFileSync(p,JSON.stringify(v));
  save(w,input);save(l,input);
  const run=()=>spawnSync(process.execPath,[tool,'--windows',w,'--linux',l,'--expected-commit',SHA],
    {encoding:'utf8',timeout:10000,windowsHide:true});
  return {dir,input,w,l,save,run};
}
test('same source SHA/tree/file inventory is accepted independently from runtime and GUI parity',()=>{
 const f=fixture();
 try{
   const r=f.run();
   assert.equal(r.status,0,r.stderr);
   const a=JSON.parse(r.stdout);
   assert.equal(a.status,'NATIVE_INSTALLER_COMMON_CORE_PARITY_PASS');
   assert.equal(a.files,107);
   assert.equal(a.nativeUiOrFeatureParityVerified,false);
   assert.equal(a.realDeploymentVerified,false);
 }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('distinct source file bytes, tree, count or expected commit refuse parity',()=>{
 const f=fixture();
 try{
   for(const mutation of [
     x=>{x.files['src/entry-000.mjs']='0'.repeat(64)},
     x=>{x.tree='0'.repeat(40)},
     x=>{x.files['src/entry-002.mjs']='bad'},
     x=>{delete x.files['src/entry-005.mjs']},
     x=>{x.head='0'.repeat(40)},
   ]){
     const changed=structuredClone(f.input);mutation(changed);f.save(f.l,changed);
     const result=f.run();
     assert.equal(result.status,2, result.stdout);
     assert.equal(JSON.parse(result.stderr).status,'NATIVE_INSTALLER_COMMON_CORE_PARITY_FAILED');
   }
 }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});
