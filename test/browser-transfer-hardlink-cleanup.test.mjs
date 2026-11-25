import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {persistDownloadAtomically} from '../tools/browser-transfer-native.mjs';
import {inspectBrowserDownload} from '../src/browser-file-transfer-guard.mjs';

const data=Buffer.from('V104_HARDLINK_CLEANUP_FAILURE_RECOVERY\n');
const sha=createHash('sha256').update(data).digest('hex');
function scope(fn){
 const profileDir=fs.mkdtempSync(path.join(os.tmpdir(),'v104-hardlink-cleanup-'));
 try{return fn(profileDir);}
 finally{fs.rmSync(profileDir,{recursive:true,force:true});}
}
test('published file is preserved and cleanup error is explicit when temporary unlink is forbidden',()=>scope(profileDir=>{
 const original=fs.unlinkSync;
 let denied=0;
 const mock=Object.create(fs);
 mock.unlinkSync=(p)=>{
  if(path.basename(p).startsWith('.rc-transfer-part-')){
   denied++;
   const err=new Error('simulated access denied');err.code='EACCES';throw err;
  }
  return original(p);
 };
 assert.throws(()=>persistDownloadAtomically({profileDir,filename:'receipt.txt',bytes:data,files:mock}),error=>{
  assert.equal(error.browserCode,'BROWSER_TRANSFER_PARTIAL_CLEANUP_FAILED');
  return true;
 });
 assert.equal(denied,1);
 const dir=path.join(profileDir,'downloads');
 const saved=path.join(dir,'receipt.txt');
 assert.deepEqual(fs.readFileSync(saved),data,'do not delete confirmed contents');
 const temporaries=fs.readdirSync(dir).filter(name=>name.startsWith('.rc-transfer-part-'));
 assert.equal(temporaries.length,1);
 assert.equal(fs.statSync(saved).nlink,2);
 // Reconciliation is explicit and limited to this test-owned profile.
 fs.unlinkSync(path.join(dir,temporaries[0]));
 const recovered=inspectBrowserDownload({profileDir,filename:'receipt.txt'});
 assert.equal(recovered.sha256,sha);
 assert.equal(fs.statSync(saved).nlink,1);
}));
test('already removed temporary file is treated as reconciled ENOENT, with valid destination',()=>scope(profileDir=>{
 const mock=Object.create(fs);
 mock.unlinkSync=p=>{
  fs.unlinkSync(p);
  const error=new Error('already absent');error.code='ENOENT';throw error;
 };
 const saved=persistDownloadAtomically({profileDir,filename:'receipt.txt',bytes:data,files:mock});
 assert.equal(saved.ok,true);assert.equal(saved.sha256,sha);
 assert.deepEqual(fs.readdirSync(path.join(profileDir,'downloads')),['receipt.txt']);
 assert.equal(fs.statSync(path.join(profileDir,'downloads','receipt.txt')).nlink,1);
}));
