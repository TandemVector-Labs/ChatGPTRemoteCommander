import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {verifyOwnerPinnedNativeRelease}
  from '../packaging/unified/owner-pinned-provenance.mjs';

const sha=v=>createHash('sha256').update(v).digest('hex');

test('owner-pinned unsigned candidate and rollback verify real file bytes without promotion',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rc012-provenance-'));
 const candidatePath=path.join(dir,'candidate.bin');
 const rollbackPath=path.join(dir,'rollback.bin');
 const manifestPath=path.join(dir,'manifest.json');
 const candidate=Buffer.from('candidate release artifact bytes');
 const rollback=Buffer.from('different historical rollback bytes');
 const head='a'.repeat(40);
 try{
   await writeFile(candidatePath,candidate);
   await writeFile(rollbackPath,rollback);
   const manifest=JSON.stringify({
     schema:1,sourceHead:head,platform:process.platform==='win32'?'win32':'linux',
     candidate:{sha256:sha(candidate),bytes:candidate.length},
     rollback:{sha256:sha(rollback),bytes:rollback.length}
   });
   await writeFile(manifestPath,manifest);
   const opts={
     manifestPath,candidatePath,rollbackPath,ownerPinnedHead:head,
     ownerPinnedManifestSha256:sha(manifest),
     platform:process.platform==='win32'?'win32':'linux'
   };
   const result=await verifyOwnerPinnedNativeRelease(opts);
   assert.equal(result.ownerPinnedNativeReleaseVerified,true);
   assert.equal(result.ownerPinnedRollbackVerified,true);
   assert.equal(result.releaseProvenance,'owner-pinned-sha256');
   assert.equal(result.promoteAllowed,false);
   // Same regular files through Windows extended-length spelling must remain
   // valid. This is distinct from symbolic *leaf* links, which are denied.
   if(process.platform==='win32'){
     const extended=p=>p.startsWith('\\\\?\\')?p:'\\\\?\\'+p;
     const equivalent=await verifyOwnerPinnedNativeRelease({
       ...opts,manifestPath:extended(manifestPath),
       candidatePath:extended(candidatePath),
       rollbackPath:extended(rollbackPath)
     });
     assert.equal(equivalent.ownerPinnedNativeReleaseVerified,true);
     assert.equal(equivalent.promoteAllowed,false);
   }

   assert.ok(!JSON.stringify(result).includes(dir));
   await assert.rejects(verifyOwnerPinnedNativeRelease({
     ...opts,ownerPinnedHead:'b'.repeat(40)
   }),/RC012_PROVENANCE_MANIFEST_INVALID/);
   await assert.rejects(verifyOwnerPinnedNativeRelease({
     ...opts,ownerPinnedManifestSha256:'f'.repeat(64)
   }),/RC012_PROVENANCE_OWNER_MANIFEST_MISMATCH/);
   await assert.rejects(verifyOwnerPinnedNativeRelease({
     ...opts,rollbackPath:candidatePath
   }),/RC012_PROVENANCE_DISTINCT_FILES_REQUIRED/);
   await writeFile(rollbackPath,'changed rollback');
   await assert.rejects(verifyOwnerPinnedNativeRelease(opts),
     /RC012_PROVENANCE_ROLLBACK_MISMATCH/);
   await writeFile(rollbackPath,rollback);
   await writeFile(candidatePath,'different candidate');
   await assert.rejects(verifyOwnerPinnedNativeRelease(opts),
     /RC012_PROVENANCE_CANDIDATE_MISMATCH/);
   await writeFile(candidatePath,candidate);
   const link=path.join(dir,'candidate-link.bin');
   try{
     await symlink(candidatePath,link,'file');
     await assert.rejects(verifyOwnerPinnedNativeRelease({
       ...opts,candidatePath:link
     }),/ELOOP|RC012_PROVENANCE/);
   }catch(error){
     if(!['EPERM','EACCES','ENOTSUP'].includes(error?.code))throw error;
   }
 }finally{
   await rm(dir,{recursive:true,force:true});
 }
});
test('owner pin, source head and platform required before reading any artifacts',async()=>{
 await assert.rejects(verifyOwnerPinnedNativeRelease({
   manifestPath:'/tmp/none',candidatePath:'/tmp/none2',
   rollbackPath:'/tmp/none3',ownerPinnedHead:'bad',
   ownerPinnedManifestSha256:'a'.repeat(64),platform:'linux'
 }),/RC012_PROVENANCE_OWNER_PIN_REQUIRED/);
});
