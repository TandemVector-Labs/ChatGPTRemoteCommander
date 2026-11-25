// Isolated Commander-owned browser transfer adapter. This is not an authorization boundary.
// Only the controller may call it after verifying an owner-scoped V1-01 grant.
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { resolveBrowserStagedUpload, inspectBrowserDownload } from '../src/browser-file-transfer-guard.mjs';

const fail = code => Object.assign(new Error(code), { browserCode: code });
const MAX_DOWNLOAD = 4 * 1024 * 1024;
const MAX_SELECTOR = 512;
const safeName = value => typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(value) &&
  value !== '.' && value !== '..' && !value.includes('..') && !/[. ]$/.test(value) &&
  !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value) &&
  !/^(?:Cookies|Login Data|Local State|logins\.json|key[0-9]?\.db)$/i.test(value);
const safeSelector = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_SELECTOR;
function assertContext(req, profileDir, evaluate, send) {
  if(!profileDir || !path.isAbsolute(profileDir) || !safeSelector(req?.selector) ||
     !safeName(req?.filename) || typeof req?.origin !== 'string' ||
     typeof evaluate !== 'function' || typeof send !== 'function')
    throw fail('BROWSER_TRANSFER_INVALID_ARGUMENTS');
  let target;
  try{target=new URL(req.origin);}catch{throw fail('BROWSER_TRANSFER_ORIGIN_DENIED');}
  if(!['https:','http:'].includes(target.protocol)||target.username||target.password||
     target.origin!==req.origin)throw fail('BROWSER_TRANSFER_ORIGIN_DENIED');
  return target.origin;
}
async function confirmOrigin(origin, evaluate) {
  const actual=await evaluate('location.origin');
  if(actual!==origin)throw fail('BROWSER_TRANSFER_PAGE_ORIGIN_CHANGED');
}
export async function uploadStagedFileCdp({req,profileDir,evaluate,send}) {
  const origin=assertContext(req,profileDir,evaluate,send);
  if(typeof req.sha256!=='string')throw fail('BROWSER_TRANSFER_DIGEST_REQUIRED');
  await confirmOrigin(origin,evaluate);
  let staged;
  try{staged=resolveBrowserStagedUpload({profileDir,filename:req.filename,expectedSha256:req.sha256});}
  catch(e){throw fail(e.code ?? 'BROWSER_TRANSFER_STAGE_DENIED');}
  // Selector input is CDP data and never interpolated into JavaScript.
  // Bind one selected DOM node for both preflight and attachment verification.
  let objectId;
  try {
    const doc=await send('DOM.getDocument',{depth:-1,pierce:false});
    const found=await send('DOM.querySelector',{nodeId:doc.root.nodeId,selector:req.selector});
    const nodeId=found?.nodeId;
    if(!nodeId)throw fail('BROWSER_TRANSFER_INPUT_NOT_FOUND');
    const resolved=await send('DOM.resolveNode',{nodeId});
    objectId=resolved?.object?.objectId;
    if(typeof objectId!=='string'||!objectId)
      throw fail('BROWSER_TRANSFER_INPUT_NOT_FOUND');
    const checked=await send('Runtime.callFunctionOn',{
      objectId,
      functionDeclaration:'function(){return this.tagName==="INPUT" && this.type==="file" && !this.disabled;}',
      returnByValue:true
    });
    if(checked?.exceptionDetails||checked?.result?.value!==true)
      throw fail('BROWSER_TRANSFER_FILE_INPUT_REQUIRED');
    await confirmOrigin(origin,evaluate);
    await send('DOM.setFileInputFiles',{files:[staged.absolutePath],nodeId});
    const inspected=await send('Runtime.callFunctionOn',{
      objectId,
      functionDeclaration:'function(){return {name:this.files?.[0]?.name??null,size:this.files?.[0]?.size??null,length:this.files?.length??0};}',
      returnByValue:true
    });
    if(inspected?.exceptionDetails)throw fail('BROWSER_TRANSFER_UPLOAD_NOT_CONFIRMED');
    const observed=inspected?.result?.value;
    if(observed?.name!==staged.filename||observed?.size!==staged.bytes||observed?.length!==1)
      throw fail('BROWSER_TRANSFER_UPLOAD_NOT_CONFIRMED');
  }catch(error){
    throw fail(error.browserCode || 'BROWSER_TRANSFER_CDP_UPLOAD_FAILED');
  }finally{
    if(objectId)try{await send('Runtime.releaseObject',{objectId});}catch{}
  }
  // Never include the real host path or file contents in the MCP result.
  return {ok:true,attached:true,filename:staged.filename,bytes:staged.bytes,
    sha256:staged.sha256,background:true,verificationRequired:true};
}
function validateDownloadDestination({profileDir,filename,files=fs}) {
  if(typeof profileDir!=='string'||!path.isAbsolute(profileDir)||!safeName(filename))
    throw fail('BROWSER_TRANSFER_INVALID_ARGUMENTS');
  const dir=path.join(profileDir,'downloads');
  try{files.mkdirSync(dir,{mode:0o700});}
  catch(e){if(e.code!=='EEXIST')throw fail('BROWSER_TRANSFER_DIRECTORY_DENIED');}
  try{
    const status=files.lstatSync(dir);
    if(status.isSymbolicLink()||!status.isDirectory()||files.realpathSync(dir)!==dir)
      throw fail('BROWSER_TRANSFER_DIRECTORY_DENIED');
  }catch{throw fail('BROWSER_TRANSFER_DIRECTORY_DENIED');}
  const destination=path.join(dir,filename);
  if(files.existsSync(destination))throw fail('BROWSER_TRANSFER_DEST_EXISTS');
  return {dir,destination};
}
/**
 * Remove only old, exclusively linked, regular temporary files created by this
 * adapter in a Commander-owned download directory. Entries are bounded to
 * prevent untrusted directory contents from causing an unbounded scan.
 * This is a local maintenance operation, not an MCP filesystem API.
 */
export function pruneStaleOwnedDownloadPartials({
  profileDir,files=fs,nowMs=Date.now(),minAgeMs=24*60*60*1000,
  maxEntries=256,maxDeletes=16
}={}) {
  if(!Number.isFinite(nowMs)||!Number.isSafeInteger(minAgeMs)||minAgeMs<60000||
     !Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>256||
     !Number.isSafeInteger(maxDeletes)||maxDeletes<1||maxDeletes>16)
    throw fail('BROWSER_TRANSFER_PARTIAL_CLEANUP_INVALID_ARGUMENTS');
  if(typeof profileDir!=='string'||!path.isAbsolute(profileDir))
    throw fail('BROWSER_TRANSFER_INVALID_ARGUMENTS');
  const dir=path.join(profileDir,'downloads');
  let dirStatus;
  try{
    dirStatus=files.lstatSync(dir);
    if(!dirStatus.isDirectory()||dirStatus.isSymbolicLink()||
       files.realpathSync(dir)!==dir)throw Error('unsafe directory');
  }catch{throw fail('BROWSER_TRANSFER_DIRECTORY_DENIED');}
  let scanned=0,removed=0,handle;
  try{
    handle=files.opendirSync(dir);
    while(scanned<maxEntries && removed<maxDeletes){
      const entry=handle.readSync();
      if(!entry)break;
      scanned++;
      const name=entry.name;
      if(!/^\.rc-transfer-part-[a-f0-9]{32}$/.test(name))continue;
      const full=path.join(dir,name);
      let s;
      try{s=files.lstatSync(full);}catch(e){if(e?.code==='ENOENT')continue;throw e;}
      if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||
         !Number.isFinite(s.mtimeMs)||nowMs-s.mtimeMs<minAgeMs)continue;
      try{files.unlinkSync(full);removed++;}
      catch(e){if(e?.code!=='ENOENT')throw e;}
    }
  }catch{throw fail('BROWSER_TRANSFER_PARTIAL_CLEANUP_FAILED');}
  finally{
    if(handle)try{handle.closeSync();}catch{}
  }
  return Object.freeze({scanned,removed});
}

/**
 * Write into an unpredictable private partial file, fsync, and publish by hard link.
 * A hard link is deliberately used instead of rename: POSIX rename can replace an
 * existing file. If the filesystem forbids atomic link, fail closed.
 */
export function persistDownloadAtomically({
  profileDir,filename,bytes,maxBytes=MAX_DOWNLOAD,files=fs
}={}) {
  if(!Buffer.isBuffer(bytes)||!Number.isSafeInteger(maxBytes)||maxBytes<1||
     maxBytes>MAX_DOWNLOAD||bytes.length>maxBytes)throw fail('BROWSER_TRANSFER_LIMIT_INVALID');
  const {dir,destination}=validateDownloadDestination({profileDir,filename,files});
  pruneStaleOwnedDownloadPartials({profileDir,files});
  const partial=path.join(dir,'.rc-transfer-part-'+randomBytes(16).toString('hex'));
  let fd,created=false,published=false,partialCleanupFailed=false;
  try{
    fd=files.openSync(partial,files.constants.O_WRONLY|files.constants.O_CREAT|
      files.constants.O_EXCL|(files.constants.O_NOFOLLOW??0),0o600);
    created=true;
    let offset=0;
    while(offset<bytes.length){
      const n=files.writeSync(fd,bytes,offset,bytes.length-offset,offset);
      if(n<=0)throw fail('BROWSER_TRANSFER_DOWNLOAD_WRITE_FAILED');
      offset+=n;
    }
    files.fsyncSync(fd);
    files.closeSync(fd);fd=undefined;
    try{files.linkSync(partial,destination);published=true;}
    catch(e){
      if(e?.code==='EEXIST')throw fail('BROWSER_TRANSFER_DEST_EXISTS');
      throw fail('BROWSER_TRANSFER_ATOMIC_PUBLISH_UNAVAILABLE');
    }
  }catch(e){
    if(e?.browserCode)throw e;
    throw fail('BROWSER_TRANSFER_DOWNLOAD_WRITE_FAILED');
  }finally{
    if(fd!==undefined){try{files.closeSync(fd);}catch{}}
    if(created){
      try{files.unlinkSync(partial);}
      catch(e){if(e?.code!=='ENOENT')partialCleanupFailed=true;}
    }
  }
  // A published destination with a second hard link is not an accepted download:
  // never hide a failed cleanup behind a generic digest/type error, and never
  // delete the completed destination as a blind compensation.
  if(partialCleanupFailed)throw fail('BROWSER_TRANSFER_PARTIAL_CLEANUP_FAILED');
  if(!published)throw fail('BROWSER_TRANSFER_DOWNLOAD_WRITE_FAILED');
  let verified;
  try{verified=inspectBrowserDownload({profileDir,filename,maxBytes,files});}
  catch(e){throw fail(e.code||'BROWSER_TRANSFER_DOWNLOAD_VERIFY_FAILED');}
  return {ok:true,downloaded:true,filename:verified.filename,bytes:verified.bytes,
    sha256:verified.sha256,background:true,verificationRequired:true};
}

export async function downloadSameOriginCdp({req,profileDir,evaluate,send}) {
  const origin=assertContext(req,profileDir,evaluate,send);
  const maxBytes=req.maxBytes??MAX_DOWNLOAD;
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>MAX_DOWNLOAD)
    throw fail('BROWSER_TRANSFER_LIMIT_INVALID');
  await confirmOrigin(origin,evaluate);
  validateDownloadDestination({profileDir,filename:req.filename});
  const expression=`(async()=>{
    const a=document.querySelector(${JSON.stringify(req.selector)});
    if(!a||a.tagName!=='A'||!a.hasAttribute('download')||
       a.getAttribute('download')!==${JSON.stringify(req.filename)})return {ok:false,code:'BROWSER_TRANSFER_DOWNLOAD_LINK_REQUIRED'};
    let url;try{url=new URL(a.href,location.href);}catch{return {ok:false,code:'BROWSER_TRANSFER_DOWNLOAD_URL_DENIED'};}
    if(url.origin!==${JSON.stringify(origin)}||!['https:','http:'].includes(url.protocol)||
      url.username||url.password)return {ok:false,code:'BROWSER_TRANSFER_DOWNLOAD_URL_DENIED'};
    let res;try{res=await fetch(url.href,{method:'GET',credentials:'same-origin',redirect:'error',cache:'no-store'});}
    catch{return {ok:false,code:'BROWSER_TRANSFER_DOWNLOAD_FETCH_FAILED'};}
    if(!res.ok||!res.body)return {ok:false,code:'BROWSER_TRANSFER_DOWNLOAD_HTTP_FAILED'};
    const limit=${maxBytes};let total=0;const chunks=[];const reader=res.body.getReader();
    try{
      while(true){const {done,value}=await reader.read();if(done)break;
       total+=value.length;if(total>limit){await reader.cancel();return {ok:false,code:'BROWSER_TRANSFER_DOWNLOAD_TOO_LARGE'};}
       chunks.push(value);
      }
    }catch{return {ok:false,code:'BROWSER_TRANSFER_DOWNLOAD_READ_FAILED'};}
    const all=new Uint8Array(total);let offset=0;
    for(const c of chunks){all.set(c,offset);offset+=c.length;}
    let bin='';for(let i=0;i<total;i+=8192)bin+=String.fromCharCode(...all.subarray(i,i+8192));
    return {ok:true,data:btoa(bin),bytes:total};
  })()`;
  let result;
  try{result=await evaluate(expression,{timeoutMs:30000});}
  catch{throw fail('BROWSER_TRANSFER_DOWNLOAD_EVALUATION_FAILED');}
  if(!result?.ok)throw fail(/^BROWSER_TRANSFER_[A-Z_]+$/.test(result?.code??'')?result.code:'BROWSER_TRANSFER_DOWNLOAD_FAILED');
  if(!Number.isSafeInteger(result.bytes)||result.bytes>maxBytes||result.bytes<0||
     typeof result.data!=='string')throw fail('BROWSER_TRANSFER_DOWNLOAD_INVALID_BYTES');
  const bytes=Buffer.from(result.data,'base64');
  if(bytes.length!==result.bytes)throw fail('BROWSER_TRANSFER_DOWNLOAD_INVALID_BYTES');
  return persistDownloadAtomically({profileDir,filename:req.filename,bytes,maxBytes});
}
