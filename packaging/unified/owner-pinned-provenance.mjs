// Read-only native release provenance for owner-approved unsigned v0.12 builds.
// The expected manifest digest and commit MUST be pinned independently by the
// owner/release authority. A hash found inside its own download is NOT trust.
// No Authenticode, installation, network access, permission grant or promotion.
import path from 'node:path';
import {open,realpath,lstat} from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import {createHash} from 'node:crypto';

const HEAD=/^[a-f0-9]{40}$/;
const HASH=/^[a-f0-9]{64}$/;
const MAX_MANIFEST=4096;
const MAX_ARTIFACT=1536*1024*1024;
const fail=code=>{throw Object.assign(new Error(code),{code});};
function exact(value,keys){
  return value&&Object.getPrototypeOf(value)===Object.prototype
    &&Object.keys(value).length===keys.length
    &&keys.every(k=>Object.hasOwn(value,k));
}
async function fingerprint(file,maxBytes){
  if(typeof file!=='string'||!path.isAbsolute(file)||file.includes('\0'))
    fail('RC012_PROVENANCE_LOCAL_FILE_REQUIRED');
  // Windows can ignore O_NOFOLLOW. Reject a linked *leaf* with lstat,
  // then check canonical target stability across the read. The supplied path
  // can spell the same trusted file differently (Windows extended paths or
  // a stable parent junction); that spelling difference is not a link attack.
  const firstLink=await lstat(file);
  if(!firstLink.isFile()||firstLink.isSymbolicLink()||firstLink.nlink!==1)
    fail('RC012_PROVENANCE_FILE_UNTRUSTED');
  const firstReal=await realpath(file);
  let handle;
  try{
    handle=await open(file,fsConstants.O_RDONLY|(fsConstants.O_NOFOLLOW||0));
    const before=await handle.stat();
    if(!before.isFile()||before.nlink!==1||before.size<1
      ||before.size>maxBytes||!Number.isSafeInteger(before.size))
      fail('RC012_PROVENANCE_FILE_UNTRUSTED');
    const digest=createHash('sha256'),chunks=[];
    let bytes=0;
    for await(const chunk of handle.createReadStream({autoClose:false,highWaterMark:65536})){
      bytes+=chunk.length;
      if(bytes>maxBytes)fail('RC012_PROVENANCE_FILE_LIMIT');
      digest.update(chunk);
      if(maxBytes===MAX_MANIFEST)chunks.push(chunk);
    }
    const after=await handle.stat();
    const lastLink=await lstat(file);
    const lastReal=await realpath(file);
    if(!lastLink.isFile()||lastLink.isSymbolicLink()||lastLink.nlink!==1
      ||lastLink.ino!==firstLink.ino||lastLink.dev!==firstLink.dev
      ||(process.platform==='win32'
        ?path.resolve(lastReal).toLowerCase()!==path.resolve(firstReal).toLowerCase()
        :path.resolve(lastReal)!==path.resolve(firstReal))
      ||bytes!==before.size||after.size!==before.size
      ||after.dev!==before.dev||after.ino!==before.ino
      ||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)
      fail('RC012_PROVENANCE_FILE_CHANGED');
    return {sha256:digest.digest('hex'),bytes,
      ...(maxBytes===MAX_MANIFEST?{data:Buffer.concat(chunks).toString('utf8')}:{})};
  }finally{
    await handle?.close();
  }
}
function artifact(value){
  return exact(value,['sha256','bytes'])
    &&typeof value.sha256==='string'&&HASH.test(value.sha256)
    &&Number.isSafeInteger(value.bytes)&&value.bytes>0
    &&value.bytes<=MAX_ARTIFACT;
}
/**
 * Before invoking, the owner must independently approve the full manifest
 * SHA-256 and exact Git head; neither comes from the downloaded candidate.
 * Both candidate and rollback must be intact regular owner-selected files.
 */
export async function verifyOwnerPinnedNativeRelease({
  manifestPath,ownerPinnedManifestSha256,ownerPinnedHead,
  candidatePath,rollbackPath,platform
}={}){
  if(typeof ownerPinnedManifestSha256!=='string'
    ||!HASH.test(ownerPinnedManifestSha256)
    ||typeof ownerPinnedHead!=='string'||!HEAD.test(ownerPinnedHead)
    ||!['win32','linux'].includes(platform))
    fail('RC012_PROVENANCE_OWNER_PIN_REQUIRED');
  const paths=[manifestPath,candidatePath,rollbackPath];
  if(paths.some(p=>typeof p!=='string'||!path.isAbsolute(p))
    ||new Set(paths.map(p=>path.resolve(p).toLowerCase())).size!==3)
    fail('RC012_PROVENANCE_DISTINCT_FILES_REQUIRED');
  const resolved=await Promise.all(paths.map(p=>realpath(p)));
  if(new Set(resolved.map(p=>p.toLowerCase())).size!==3)
    fail('RC012_PROVENANCE_DISTINCT_FILES_REQUIRED');
  const manifest=await fingerprint(manifestPath,MAX_MANIFEST);
  if(manifest.sha256!==ownerPinnedManifestSha256)
    fail('RC012_PROVENANCE_OWNER_MANIFEST_MISMATCH');
  let parsed;
  try{parsed=JSON.parse(manifest.data);}catch{
    fail('RC012_PROVENANCE_MANIFEST_INVALID');
  }
  if(!exact(parsed,['schema','sourceHead','platform','candidate','rollback'])
    ||parsed.schema!==1||parsed.sourceHead!==ownerPinnedHead
    ||parsed.platform!==platform
    ||!artifact(parsed.candidate)||!artifact(parsed.rollback)
    ||parsed.candidate.sha256===parsed.rollback.sha256)
    fail('RC012_PROVENANCE_MANIFEST_INVALID');
  const [candidate,rollback]=await Promise.all([
    fingerprint(candidatePath,MAX_ARTIFACT),
    fingerprint(rollbackPath,MAX_ARTIFACT)
  ]);
  if(candidate.sha256!==parsed.candidate.sha256
    ||candidate.bytes!==parsed.candidate.bytes)
    fail('RC012_PROVENANCE_CANDIDATE_MISMATCH');
  if(rollback.sha256!==parsed.rollback.sha256
    ||rollback.bytes!==parsed.rollback.bytes)
    fail('RC012_PROVENANCE_ROLLBACK_MISMATCH');
  // These facts may satisfy the provenance integrity inputs of a separate
  // preflight; the real release and reversible install still require approval.
  return Object.freeze({
    sourceHead:ownerPinnedHead,platform,
    releaseProvenance:'owner-pinned-sha256',
    ownerPinnedNativeReleaseVerified:true,
    ownerPinnedRollbackVerified:true,
    candidateSha256:candidate.sha256,rollbackSha256:rollback.sha256,
    promoteAllowed:false
  });
}
