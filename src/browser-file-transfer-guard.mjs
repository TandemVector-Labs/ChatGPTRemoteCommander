import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const BROWSER_TRANSFER_MAX_BYTES = 16 * 1024 * 1024;
const FAIL = code => Object.assign(new Error(code), {code});
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._ -]{0,127}$/;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const DIGEST = /^[a-f0-9]{64}$/;
function fileName(name) {
  if (typeof name !== 'string' || !SAFE_NAME.test(name) || name === '.' || name === '..' ||
      /[. ]$/.test(name) || RESERVED.test(name) || name.includes('..') ||
      /^(?:cookies|login data|local state|logins\.json|key[0-9]?\.db)$/i.test(name))
    throw FAIL('BROWSER_TRANSFER_FILENAME_DENIED');
  return name;
}
function pathStatus(p, files) {
  let s;
  try { s=files.lstatSync(p); } catch { throw FAIL('BROWSER_TRANSFER_FILE_NOT_FOUND'); }
  if(s.isSymbolicLink())throw FAIL('BROWSER_TRANSFER_SYMLINK_DENIED');
  return s;
}
function rootStatus(profileDir, files) {
  if(typeof profileDir!=='string'||!path.isAbsolute(profileDir))throw FAIL('BROWSER_TRANSFER_PROFILE_REQUIRED');
  const status=pathStatus(profileDir,files);
  if(!status.isDirectory())throw FAIL('BROWSER_TRANSFER_PROFILE_NOT_DIRECTORY');
  // The trusted browser controller alone supplies this Commander-owned directory.
  return files.realpathSync(profileDir);
}
function openVerifiedFile(file, files, maxBytes){
  const s=pathStatus(file,files);
  if(!s.isFile() || s.size<0 || s.size>maxBytes || s.nlink>1)throw FAIL('BROWSER_TRANSFER_FILE_TYPE_OR_SIZE_DENIED');
  let fd;
  try {
    fd=files.openSync(file,files.constants.O_RDONLY | (files.constants.O_NOFOLLOW ?? 0));
    const current=files.fstatSync(fd);
    if(!current.isFile() || current.size!==s.size || current.size>maxBytes || current.nlink>1 ||
       (current.ino && s.ino && current.ino!==s.ino))
      throw FAIL('BROWSER_TRANSFER_FILE_CHANGED');
    const hash=createHash('sha256'), buffer=Buffer.allocUnsafe(65536);
    let off=0;
    while(off<current.size){
      const n=files.readSync(fd,buffer,0,Math.min(buffer.length,current.size-off),off);
      if(n<=0)throw FAIL('BROWSER_TRANSFER_FILE_CHANGED');
      hash.update(buffer.subarray(0,n));off+=n;
    }
    if(files.fstatSync(fd).size!==current.size)throw FAIL('BROWSER_TRANSFER_FILE_CHANGED');
    return {bytes:current.size,sha256:hash.digest('hex')};
  } finally {if(fd!==undefined)files.closeSync(fd);}
}
/**
 * Backend-only check: an application-level "FULL_POWER" flag is not a grant.
 * The verifier must be injected by V1-01 from a trusted, authenticated host boundary,
 * never from MCP input or a browser page.
 */
export async function requireBrowserTransferGrant({
  verifyGrant,operation,principal,profile,origin,filename,grant
}={}){
  if(typeof verifyGrant!=='function'||!['upload','download'].includes(operation)||
     typeof principal!=='string'||!principal||typeof profile!=='string'||!profile||
     typeof filename!=='string'||!filename||typeof origin!=='string'||
     !/^https?:$/.test((()=>{try{return new URL(origin).protocol;}catch{return '';}})()))
    throw FAIL('BROWSER_TRANSFER_AUTH_CONTEXT_REQUIRED');
  const target=new URL(origin);
  if(target.username||target.password||target.origin!==(origin.replace(/\/$/,'')))
    throw FAIL('BROWSER_TRANSFER_ORIGIN_INVALID');
  let verified=false;
  try {verified=await verifyGrant({grant,capability:'browser.file-transfer',operation,principal,profile,origin:target.origin,filename})===true;} catch{}
  if(!verified)throw FAIL('BROWSER_TRANSFER_GRANT_REQUIRED');
  return Object.freeze({authorized:true,operation,origin:target.origin});
}
/**
 * Path is internal-only; do not return it through a public browser tool.
 * The staged file must already have been placed in a Commander-owned upload folder
 * through an independent authorized filesystem operation. expectedSha256 is mandatory.
 */
export function resolveBrowserStagedUpload({profileDir,filename,expectedSha256,maxBytes=BROWSER_TRANSFER_MAX_BYTES,files=fs}={}){
  const name=fileName(filename);
  if(typeof expectedSha256!=='string'||!DIGEST.test(expectedSha256))
    throw FAIL('BROWSER_TRANSFER_DIGEST_REQUIRED');
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>BROWSER_TRANSFER_MAX_BYTES)
    throw FAIL('BROWSER_TRANSFER_LIMIT_INVALID');
  const root=rootStatus(profileDir,files);
  const stage=path.join(root,'uploads');
  if(!pathStatus(stage,files).isDirectory())throw FAIL('BROWSER_TRANSFER_STAGE_NOT_DIRECTORY');
  if(files.realpathSync(stage)!==stage)throw FAIL('BROWSER_TRANSFER_STAGE_REDIRECTED');
  const target=path.join(stage,name), info=openVerifiedFile(target,files,maxBytes);
  if(info.sha256!==expectedSha256)throw FAIL('BROWSER_TRANSFER_DIGEST_MISMATCH');
  return Object.freeze({absolutePath:target,bytes:info.bytes,sha256:info.sha256,filename:name});
}
/** Inspect completed downloads only under the owned profile's downloads folder. */
export function inspectBrowserDownload({profileDir,filename,maxBytes=BROWSER_TRANSFER_MAX_BYTES,files=fs}={}){
  const name=fileName(filename);
  if(name.endsWith('.crdownload')||name.endsWith('.part'))throw FAIL('BROWSER_TRANSFER_PARTIAL_FILE');
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>BROWSER_TRANSFER_MAX_BYTES)
    throw FAIL('BROWSER_TRANSFER_LIMIT_INVALID');
  const root=rootStatus(profileDir,files),folder=path.join(root,'downloads');
  if(!pathStatus(folder,files).isDirectory()||files.realpathSync(folder)!==folder)
    throw FAIL('BROWSER_TRANSFER_STAGE_REDIRECTED');
  const info=openVerifiedFile(path.join(folder,name),files,maxBytes);
  return Object.freeze({filename:name,bytes:info.bytes,sha256:info.sha256,verifiedLocalFile:true});
}
