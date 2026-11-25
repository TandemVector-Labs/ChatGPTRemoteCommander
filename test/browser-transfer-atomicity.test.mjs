import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {persistDownloadAtomically} from '../tools/browser-transfer-native.mjs';

const sample=Buffer.from('RC V1-04 ATOMIC DOWNLOAD CONTENT\n');
const digest=createHash('sha256').update(sample).digest('hex');
function fixture(fn){
 const profileDir=fs.mkdtempSync(path.join(os.tmpdir(),'rc-v104-atomic-fixture-'));
 try{return fn(profileDir);}finally{fs.rmSync(profileDir,{recursive:true,force:true});}
}
const downloadDir=root=>path.join(root,'downloads');
const leftovers=root=>fs.existsSync(downloadDir(root))?fs.readdirSync(downloadDir(root)).filter(x=>x.startsWith('.rc-transfer-part-')):[];

test('atomic publish is complete, SHA-256 verified and private partial is removed',()=>fixture(root=>{
 const r=persistDownloadAtomically({profileDir:root,filename:'receipt.txt',bytes:sample});
 assert.equal(r.ok,true);assert.equal(r.downloaded,true);
 assert.equal(r.sha256,digest);assert.equal(r.bytes,sample.length);
 assert.equal(r.filename,'receipt.txt');
 assert.ok(!JSON.stringify(r).includes(root),'MCP result does not expose absolute path');
 assert.deepEqual(fs.readFileSync(path.join(downloadDir(root),'receipt.txt')),sample);
 assert.deepEqual(leftovers(root),[]);
 const stat=fs.statSync(path.join(downloadDir(root),'receipt.txt'));
 assert.equal(stat.nlink,1,'published file has no remaining temporary hardlink');
}));
test('pre-existing destination is preserved and no partial file is created',()=>fixture(root=>{
 fs.mkdirSync(downloadDir(root));fs.writeFileSync(path.join(downloadDir(root),'receipt.txt'),'USER_FILE');
 assert.throws(()=>persistDownloadAtomically({profileDir:root,filename:'receipt.txt',bytes:sample}),/BROWSER_TRANSFER_DEST_EXISTS/);
 assert.equal(fs.readFileSync(path.join(downloadDir(root),'receipt.txt'),'utf8'),'USER_FILE');
 assert.deepEqual(leftovers(root),[]);
}));
test('disk failure after a partial write leaves neither destination nor scratch file',()=>fixture(root=>{
 let count=0;
 const files=Object.create(fs);
 files.writeSync=(fd,bytes,offset,length,position)=>{
   if(count++===0)return fs.writeSync(fd,bytes,offset,Math.min(3,length),position);
   const e=new Error('INJECTED_DISK_FULL');e.code='ENOSPC';throw e;
 };
 assert.throws(()=>persistDownloadAtomically({profileDir:root,filename:'receipt.txt',bytes:sample,files}),/BROWSER_TRANSFER_DOWNLOAD_WRITE_FAILED/);
 assert.equal(fs.existsSync(path.join(downloadDir(root),'receipt.txt')),false);
 assert.deepEqual(leftovers(root),[]);
}));
test('atomic publication fails closed if hardlinks are unsupported',()=>fixture(root=>{
 const files=Object.create(fs);
 files.linkSync=()=>{const e=new Error('INJECTED_FILESYSTEM_NO_HARDLINK');e.code='EPERM';throw e;};
 assert.throws(()=>persistDownloadAtomically({profileDir:root,filename:'receipt.txt',bytes:sample,files}),/BROWSER_TRANSFER_ATOMIC_PUBLISH_UNAVAILABLE/);
 assert.equal(fs.existsSync(path.join(downloadDir(root),'receipt.txt')),false);
 assert.deepEqual(leftovers(root),[]);
}));
test('competing writer wins without losing contents, and scratch is removed',()=>fixture(root=>{
 const files=Object.create(fs);
 const target=path.join(downloadDir(root),'receipt.txt');
 files.linkSync=(_src,dest)=>{
  assert.equal(dest,target);
  fs.writeFileSync(dest,'OTHER_WRITER');
  const e=new Error('EEXIST_INJECTED');e.code='EEXIST';throw e;
 };
 assert.throws(()=>persistDownloadAtomically({profileDir:root,filename:'receipt.txt',bytes:sample,files}),/BROWSER_TRANSFER_DEST_EXISTS/);
 assert.equal(fs.readFileSync(target,'utf8'),'OTHER_WRITER');
 assert.deepEqual(leftovers(root),[]);
}));
test('invalid bytes, traversal and oversize input fail before filesystem effect',()=>fixture(root=>{
 for(const args of [
  {filename:'receipt.txt',bytes:'raw-text'},
  {filename:'../secret.txt',bytes:sample},
  {filename:'receipt.txt',bytes:Buffer.alloc(4097),maxBytes:4096},
  {filename:'receipt.txt',bytes:sample,maxBytes:4*1024*1024+1}
 ]){
  assert.throws(()=>persistDownloadAtomically({profileDir:root,...args}),/BROWSER_TRANSFER_(?:LIMIT_INVALID|INVALID_ARGUMENTS)/);
 }
 assert.equal(fs.existsSync(downloadDir(root)),false);
}));
test('symlinked downloads directory is rejected without writing outside profile',()=>fixture(root=>{
 const outside=fs.mkdtempSync(path.join(os.tmpdir(),'rc-v104-atomic-outside-'));
 try{
  let made=true;
  try{fs.symlinkSync(outside,downloadDir(root),'dir');}
  catch(e){if(['EPERM','EACCES','ENOTSUP'].includes(e.code))made=false;else throw e;}
  if(made){
   assert.throws(()=>persistDownloadAtomically({profileDir:root,filename:'receipt.txt',bytes:sample}),/BROWSER_TRANSFER_DIRECTORY_DENIED/);
   assert.deepEqual(fs.readdirSync(outside),[]);
  }
 }finally{fs.rmSync(outside,{recursive:true,force:true});}
}));
