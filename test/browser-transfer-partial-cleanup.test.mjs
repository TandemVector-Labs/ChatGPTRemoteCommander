import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pruneStaleOwnedDownloadPartials,persistDownloadAtomically} from '../tools/browser-transfer-native.mjs';

const oldDate=new Date(Date.now()-48*60*60*1000);
const token=char=>'.rc-transfer-part-'+char.repeat(32);
const payload=Buffer.from('TEST_PARTIAL_V104');
function fixture(fn){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rc-v104-stale-part-'));
  const dir=path.join(root,'downloads');
  fs.mkdirSync(dir,{mode:0o700});
  try{return fn({root,dir});}finally{fs.rmSync(root,{recursive:true,force:true});}
}
function oldFile(dir,name,bytes=payload){
 const p=path.join(dir,name);
 fs.writeFileSync(p,bytes,{mode:0o600});
 fs.utimesSync(p,oldDate,oldDate);
 return p;
}
test('old Commander-generated partial is pruned while unrelated files remain intact',()=>fixture(({root,dir})=>{
 const stale=oldFile(dir,token('a'));
 const unrelated=oldFile(dir,'owner-notes.txt');
 const unrelatedPrefix=oldFile(dir,'.rc-transfer-part-untrusted');
 const info=pruneStaleOwnedDownloadPartials({profileDir:root});
 assert.equal(info.removed,1);assert.ok(Object.isFrozen(info));
 assert.equal(fs.existsSync(stale),false);
 assert.deepEqual(fs.readFileSync(unrelated),payload);
 assert.deepEqual(fs.readFileSync(unrelatedPrefix),payload);
}));
test('new partial is preserved; only a sufficiently old one is removed',()=>fixture(({root,dir})=>{
 const fresh=path.join(dir,token('b'));fs.writeFileSync(fresh,payload);
 const expired=oldFile(dir,token('c'));
 const info=pruneStaleOwnedDownloadPartials({profileDir:root});
 assert.equal(info.removed,1);assert.equal(fs.existsSync(fresh),true);
 assert.equal(fs.existsSync(expired),false);
}));
test('old hardlinked file and symbolic link are never pruned',()=>fixture(({root,dir})=>{
 const outside=fs.mkdtempSync(path.join(os.tmpdir(),'rc-v104-keep-external-'));
 try{
  const original=oldFile(outside,'original');
  const linked=path.join(dir,token('d'));
  fs.linkSync(original,linked);
  let symlinked=false;
  try{fs.symlinkSync(original,path.join(dir,token('e')),'file');symlinked=true;}
  catch(e){if(!['EPERM','EACCES','ENOTSUP'].includes(e?.code))throw e;}
  const info=pruneStaleOwnedDownloadPartials({profileDir:root});
  assert.equal(info.removed,0);
  assert.equal(fs.existsSync(linked),true);
  if(symlinked)assert.equal(fs.lstatSync(path.join(dir,token('e'))).isSymbolicLink(),true);
  assert.deepEqual(fs.readFileSync(original),payload);
 }finally{fs.rmSync(outside,{recursive:true,force:true});}
}));
test('maintenance is capped to 16 deletions per call',()=>fixture(({root,dir})=>{
 for(let i=0;i<18;i++)oldFile(dir,'.rc-transfer-part-'+i.toString(16).padStart(32,'0'));
 const result=pruneStaleOwnedDownloadPartials({profileDir:root});
 assert.equal(result.removed,16);
 assert.equal(fs.readdirSync(dir).length,2);
}));
test('stale-part cleanup runs before atomic file publish and retains completed output',()=>fixture(({root,dir})=>{
 oldFile(dir,token('f'));
 const result=persistDownloadAtomically({profileDir:root,filename:'verified.txt',bytes:payload});
 assert.equal(result.ok,true);
 assert.equal(fs.existsSync(path.join(dir,token('f'))),false);
 assert.deepEqual(fs.readFileSync(path.join(dir,'verified.txt')),payload);
 assert.equal(result.sha256,createHash('sha256').update(payload).digest('hex'));
}));
test('symlinked downloads directory is rejected without touching external files',()=>fixture(({root,dir})=>{
 const outside=fs.mkdtempSync(path.join(os.tmpdir(),'rc-v104-symlink-escape-'));
 try{
  const stale=oldFile(outside,token('a'));
  fs.rmdirSync(dir);
  let supported=true;
  try{fs.symlinkSync(outside,dir,'dir');}
  catch(e){if(['EPERM','EACCES','ENOTSUP'].includes(e?.code))supported=false;else throw e;}
  if(supported){
   assert.throws(()=>pruneStaleOwnedDownloadPartials({profileDir:root}),/BROWSER_TRANSFER_DIRECTORY_DENIED/);
   assert.deepEqual(fs.readFileSync(stale),payload);
  }
 }finally{fs.rmSync(outside,{recursive:true,force:true});}
}));
test('invalid retention controls fail without deleting old files',()=>fixture(({root,dir})=>{
 const stale=oldFile(dir,token('a'));
 for(const args of [{minAgeMs:0},{maxDeletes:99},{maxEntries:1000},{nowMs:NaN}]){
  assert.throws(()=>pruneStaleOwnedDownloadPartials({profileDir:root,...args}),/BROWSER_TRANSFER_PARTIAL_CLEANUP_INVALID_ARGUMENTS/);
 }
 assert.equal(fs.existsSync(stale),true);
}));
test('unlink failure is explicit and fails closed',()=>fixture(({root,dir})=>{
 const stale=oldFile(dir,token('a'));
 const files=Object.create(fs);
 files.unlinkSync=()=>{const e=new Error('busy');e.code='EACCES';throw e;};
 assert.throws(()=>persistDownloadAtomically({profileDir:root,filename:'verified.txt',bytes:payload,files}),/BROWSER_TRANSFER_PARTIAL_CLEANUP_FAILED/);
 assert.equal(fs.existsSync(path.join(dir,'verified.txt')),false);
 assert.equal(fs.existsSync(stale),true);
}));
