import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {
  resolveBrowserStagedUpload, inspectBrowserDownload,
  requireBrowserTransferGrant, BROWSER_TRANSFER_MAX_BYTES
} from '../src/browser-file-transfer-guard.mjs';
const hash=buf=>createHash('sha256').update(buf).digest('hex');
function fixture(fn){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rc-v104-file-guard-'));
  fs.mkdirSync(path.join(root,'uploads'),{mode:0o700});
  fs.mkdirSync(path.join(root,'downloads'),{mode:0o700});
  const source=Buffer.from('RC_V104_SAMPLE_FILE\n');
  fs.writeFileSync(path.join(root,'uploads','sample.txt'),source);
  fs.writeFileSync(path.join(root,'downloads','receipt.txt'),source);
  try{return fn({root,source,digest:hash(source)});}finally{fs.rmSync(root,{recursive:true,force:true});}
}
test('approved local staged upload returns exact checked metadata',()=>fixture(({root,source,digest})=>{
  const v=resolveBrowserStagedUpload({profileDir:root,filename:'sample.txt',expectedSha256:digest});
  assert.equal(v.bytes,source.length);assert.equal(v.sha256,digest);
  assert.equal(v.absolutePath,path.join(root,'uploads','sample.txt'));
  assert.ok(Object.isFrozen(v));
}));
test('download only returns basename/size/hash, not private host paths',()=>fixture(({root,digest})=>{
 const v=inspectBrowserDownload({profileDir:root,filename:'receipt.txt'});
 assert.deepEqual(Object.keys(v).sort(),['bytes','filename','sha256','verifiedLocalFile']);
 assert.equal(v.sha256,digest);assert.equal(v.verifiedLocalFile,true);
}));
test('file path traversal and invalid names are rejected',()=>fixture(({root,digest})=>{
 for(const filename of ['../sample.txt','..','/tmp/test','C:\\secret','a/b','.env','Cookies','Login Data','Local State','CON','NUL.txt','sample.txt.','a..b.txt','x\u0000y']){
  assert.throws(()=>resolveBrowserStagedUpload({profileDir:root,filename,expectedSha256:digest}),/BROWSER_TRANSFER_FILENAME_DENIED/,filename);
 }
}));
test('invalid hash, mismatch and byte limit deny upload',()=>fixture(({root,digest})=>{
 for(const expectedSha256 of [undefined,'0'.repeat(63),'ABC'.repeat(21)+'0']){
  assert.throws(()=>resolveBrowserStagedUpload({profileDir:root,filename:'sample.txt',expectedSha256}),/BROWSER_TRANSFER_DIGEST_REQUIRED/);
 }
 assert.throws(()=>resolveBrowserStagedUpload({profileDir:root,filename:'sample.txt',expectedSha256:'0'.repeat(64)}),/BROWSER_TRANSFER_DIGEST_MISMATCH/);
 assert.throws(()=>resolveBrowserStagedUpload({profileDir:root,filename:'sample.txt',expectedSha256:digest,maxBytes:1}),/BROWSER_TRANSFER_FILE_TYPE_OR_SIZE_DENIED/);
 assert.throws(()=>resolveBrowserStagedUpload({profileDir:root,filename:'sample.txt',expectedSha256:digest,maxBytes:BROWSER_TRANSFER_MAX_BYTES+1}),/BROWSER_TRANSFER_LIMIT_INVALID/);
}));
test('non-file entries and partial downloads are blocked',()=>fixture(({root,digest})=>{
 fs.mkdirSync(path.join(root,'uploads','directory.txt'));
 assert.throws(()=>resolveBrowserStagedUpload({profileDir:root,filename:'directory.txt',expectedSha256:digest}),/BROWSER_TRANSFER_FILE_TYPE_OR_SIZE_DENIED/);
 for(const n of ['partial.crdownload','partial.part'])assert.throws(()=>inspectBrowserDownload({profileDir:root,filename:n}),/BROWSER_TRANSFER_PARTIAL_FILE/);
}));
test('symlinks are rejected when supported by OS',()=>fixture(({root,digest})=>{
 let added=false;
 try{fs.symlinkSync(path.join(root,'uploads','sample.txt'),path.join(root,'uploads','linked.txt'));added=true;}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;}
 if(added)assert.throws(()=>resolveBrowserStagedUpload({profileDir:root,filename:'linked.txt',expectedSha256:digest}),/BROWSER_TRANSFER_SYMLINK_DENIED/);
}));
test('hard links cannot alias sensitive files into the transfer area',()=>fixture(({root,digest})=>{
 const privateFile=path.join(root,'private-origin.txt');
 fs.writeFileSync(privateFile,'private-non-transfer');
 let supported=true;
 try{fs.linkSync(privateFile,path.join(root,'uploads','linked-copy.txt'));}catch(e){if(['EPERM','EACCES','ENOTSUP'].includes(e.code))supported=false;else throw e;}
 if(supported){
  assert.throws(()=>resolveBrowserStagedUpload({profileDir:root,filename:'linked-copy.txt',expectedSha256:hash(Buffer.from('private-non-transfer'))}),/BROWSER_TRANSFER_FILE_TYPE_OR_SIZE_DENIED/);
 }
}));
test('missing or redirected upload/download directories block',()=>fixture(({root,digest})=>{
 fs.renameSync(path.join(root,'uploads'),path.join(root,'uploads-disabled'));
 assert.throws(()=>resolveBrowserStagedUpload({profileDir:root,filename:'sample.txt',expectedSha256:digest}),/BROWSER_TRANSFER_FILE_NOT_FOUND/);
 fs.renameSync(path.join(root,'downloads'),path.join(root,'downloads-disabled'));
 assert.throws(()=>inspectBrowserDownload({profileDir:root,filename:'receipt.txt'}),/BROWSER_TRANSFER_FILE_NOT_FOUND/);
}));
test('grant is fail-closed without V1-01 trusted backend verifier',async()=>{
 const args={operation:'upload',principal:'sid:S-1-5-21-111',profile:'default',origin:'https://example.test',filename:'sample.txt',grant:'caller-forged'};
 await assert.rejects(requireBrowserTransferGrant(args),/BROWSER_TRANSFER_AUTH_CONTEXT_REQUIRED/);
 await assert.rejects(requireBrowserTransferGrant({...args,verifyGrant:async()=>false}),/BROWSER_TRANSFER_GRANT_REQUIRED/);
 await assert.rejects(requireBrowserTransferGrant({...args,verifyGrant:async()=>{throw Error('offline')}}),/BROWSER_TRANSFER_GRANT_REQUIRED/);
 await assert.rejects(requireBrowserTransferGrant({...args,verifyGrant:async()=>true,origin:'file:///etc/passwd'}),/BROWSER_TRANSFER_AUTH_CONTEXT_REQUIRED/);
});
test('trusted test verifier receives exact scoped capability and operation',async()=>{
 const input={operation:'download',principal:'uid:1000',profile:'testing',origin:'https://example.test/',filename:'receipt.txt',grant:'grant-id'};
 const received=[];
 const verifyGrant=async a=>(received.push(a), a.grant==='grant-id' && a.capability==='browser.file-transfer'&&a.origin==='https://example.test'&&a.operation==='download');
 const result=await requireBrowserTransferGrant({...input,verifyGrant});
 assert.equal(result.authorized,true);assert.equal(result.origin,'https://example.test');
 assert.equal(received.length,1);assert.equal(received[0].filename,'receipt.txt');
 assert.ok(Object.isFrozen(result));
});
