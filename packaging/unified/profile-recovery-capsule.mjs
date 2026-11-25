// RC012 bounded user-local configuration recovery capsule.
// Does not access credential stores, stop a service, install software, or
// restore anything automatically. Excludes large project trees by design.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const MAX_FILES=64, MAX_FILE=1024*1024, MAX_TOTAL=4*1024*1024;
const hash=data=>createHash('sha256').update(data).digest('hex');
const canonical=p=>fs.realpathSync(p);
function fail(code){throw Object.assign(new Error(code),{code});}
function ensureDir(p){
  const s=fs.lstatSync(p);
  if(!s.isDirectory()||s.isSymbolicLink())fail('RC012_RECOVERY_DIR_UNSAFE');
  const uid=process.getuid?.();
  if(uid!==undefined&&s.uid!==uid)fail('RC012_RECOVERY_OWNER_MISMATCH');
  return p;
}
function inside(parent,child){
  const rel=path.relative(parent,child);
  return !!rel&&rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);
}
function safeRelative(s){
  if(typeof s!=='string'||!s||s.length>220||s.includes('\\')||s.startsWith('/')||
    /[<>:"|?*\x00-\x1f]/.test(s)||
    s.split('/').some(v=>!v||v==='.'||v==='..')||
    !/\.(?:json|service|yaml|yml)$/.test(s))fail('RC012_RECOVERY_RELATIVE_INVALID');
  return s;
}
function safeFile(root,rel){
  let cur=root;
  const parts=rel.split('/');
  for(let i=0;i<parts.length;i++){
    cur=path.join(cur,parts[i]);
    const st=fs.lstatSync(cur);
    if(st.isSymbolicLink())fail('RC012_RECOVERY_SYMLINK_REFUSED');
    if(i<parts.length-1&&!st.isDirectory())fail('RC012_RECOVERY_PARENT_NOT_DIR');
    if(i===parts.length-1&&(!st.isFile()||st.size>MAX_FILE))
      fail('RC012_RECOVERY_SOURCE_NOT_SMALL_FILE');
  }
  return cur;
}
function pathsFor(ownerRoot,sourceRoot,recoveryRoot){
  const owner=canonical(ensureDir(ownerRoot));
  const src=canonical(ensureDir(sourceRoot));
  const recovery=canonical(ensureDir(recoveryRoot));
  if(!inside(owner,src)||!inside(owner,recovery)||src===recovery||
    inside(src,recovery)||inside(recovery,src))fail('RC012_RECOVERY_ROOT_OVERLAP');
  if(process.platform!=='win32'){
    const st=fs.statSync(recovery);
    if((st.mode&0o077)!==0)fail('RC012_RECOVERY_DIRECTORY_NOT_PRIVATE');
  }
  return {owner,source:src,recovery};
}
function verifyNoInlineSecrets(rel,data){
  const raw=data.toString('utf8');
  const sensitive=/(?:^|[_-])(?:token|secret|password|passwd|credential|api[_-]?key|cookie|private[_-]?key|client[_-]?secret)(?:$|[_-])/i;
  const riskyKey=k=>sensitive.test(k)||/(?:token|password|secret|credential|apiKey|privateKey|accessKey)$/i.test(k);
  if(rel.endsWith('.json')){
    let obj;
    try{obj=JSON.parse(raw);}catch{fail('RC012_RECOVERY_JSON_INVALID');}
    const queue=[obj];
    while(queue.length){
      const v=queue.pop();
      if(!v||typeof v!=='object')continue;
      for(const [key,value] of Object.entries(v)){
        if(riskyKey(key))fail('RC012_RECOVERY_INLINE_SECRET_REFUSED');
        if(value&&typeof value==='object')queue.push(value);
      }
    }
  }else if(/^\s*(?:Environment|EnvironmentFile|LoadCredential|SetCredential)\s*=/mi.test(raw)
    ||/--(?:token|password|secret|api[-_]?key)(?:\s|=)/i.test(raw)
    ||/^\s*(?:token|password|secret|credential|api[-_]?key)\s*[:=]/mi.test(raw)){
    fail('RC012_RECOVERY_INLINE_SECRET_REFUSED');
  }
}
function fileEntries(source,paths){
  if(!Array.isArray(paths)||paths.length<1||paths.length>MAX_FILES)
    fail('RC012_RECOVERY_FILE_COUNT');
  const seen=new Set(),out=[];let sum=0;
  for(const p of paths){
    const rel=safeRelative(p);
    if(seen.has(rel))fail('RC012_RECOVERY_DUPLICATE');
    seen.add(rel);
    const f=safeFile(source,rel);
    const data=fs.readFileSync(f);
    verifyNoInlineSecrets(rel,data);
    if(data.length>MAX_FILE|| (sum+=data.length)>MAX_TOTAL)
      fail('RC012_RECOVERY_SIZE_LIMIT');
    out.push({rel,bytes:data.length,sha256:hash(data),data});
  }
  return out.sort((a,b)=>a.rel.localeCompare(b.rel,'en'));
}
function verify(target,sourceRootDigest){
  const root=canonical(ensureDir(target));
  const m=JSON.parse(fs.readFileSync(path.join(root,'receipt.json'),'utf8'));
  if(m.schema!==1||m.sourceRootDigest!==sourceRootDigest||
    !Array.isArray(m.files)||m.files.length<1||m.files.length>MAX_FILES)
    fail('RC012_RECOVERY_RECEIPT_INVALID');
  let sum=0;
  for(const e of m.files){
    const rel=safeRelative(e.rel);
    if(!/^[a-f0-9]{64}$/.test(e.sha256)||!Number.isInteger(e.bytes)||
      e.bytes<0||e.bytes>MAX_FILE||(sum+=e.bytes)>MAX_TOTAL)
      fail('RC012_RECOVERY_RECEIPT_INVALID');
    const p=safeFile(path.join(root,'files'),rel),data=fs.readFileSync(p);
    if(data.length!==e.bytes||hash(data)!==e.sha256)
      fail('RC012_RECOVERY_DATA_TAMPERED');
  }
  return {schema:1,files:m.files.length,bytes:sum,
    receiptSha256:hash(fs.readFileSync(path.join(root,'receipt.json'))),
    baseline:Object.fromEntries(m.files.map(({rel,sha256})=>[rel,sha256]))};
}
export function stageProfileRecovery({ownerRoot,sourceRoot,recoveryRoot,relativeFiles}){
  const {source,recovery}=pathsFor(ownerRoot,sourceRoot,recoveryRoot);
  const target=path.join(recovery,'rc012-config-recovery');
  const records=fileEntries(source,relativeFiles);
  if(fs.existsSync(target)){
    const existing=verify(target,hash(source));
    for(const record of records)
      if(existing.baseline[record.rel]!==record.sha256)
        fail('RC012_RECOVERY_EXISTING_BASELINE_DIFFERENT');
    if(Object.keys(existing.baseline).length!==records.length)
      fail('RC012_RECOVERY_EXISTING_INVENTORY_DIFFERENT');
    return {...existing,reused:true,changesToSource:false};
  }
  const temp=path.join(recovery,'.rc012-incoming-'+randomUUID());
  fs.mkdirSync(temp,{mode:0o700});
  try{
    for(const e of records){
      const dest=path.join(temp,'files',...e.rel.split('/'));
      fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});
      fs.writeFileSync(dest,e.data,{flag:'wx',mode:0o600});
    }
    const manifest={schema:1,sourceRootDigest:hash(source),
      files:records.map(({rel,bytes,sha256})=>({rel,bytes,sha256}))};
    fs.writeFileSync(path.join(temp,'receipt.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
    verify(temp,manifest.sourceRootDigest);
    fs.renameSync(temp,target);
    return {...verify(target,manifest.sourceRootDigest),reused:false,changesToSource:false};
  }catch(e){
    if(fs.existsSync(temp))fs.rmSync(temp,{recursive:true,force:true});
    throw e;
  }
}
export function planProfileRollback({ownerRoot,sourceRoot,recoveryRoot,expectedCurrentHashes}){
  const {source,recovery}=pathsFor(ownerRoot,sourceRoot,recoveryRoot);
  if(!expectedCurrentHashes||typeof expectedCurrentHashes!=='object'||Array.isArray(expectedCurrentHashes))
    fail('RC012_RECOVERY_CURRENT_HASHES_REQUIRED');
  const result=verify(path.join(recovery,'rc012-config-recovery'),hash(source));
  if(Object.keys(expectedCurrentHashes).length!==Object.keys(result.baseline).length)
    fail('RC012_RECOVERY_CURRENT_INVENTORY_MISMATCH');
  for(const rel of Object.keys(result.baseline)){
    const cur=safeFile(source,rel);
    if(!/^[a-f0-9]{64}$/.test(expectedCurrentHashes[rel]||'')||
      hash(fs.readFileSync(cur))!==expectedCurrentHashes[rel])
      fail('RC012_RECOVERY_CHANGED_AFTER_PLAN');
  }
  return {schema:1,decision:'ROLLBACK_PLAN_ONLY',canRestore:false,
    fileCount:result.files,recoveryVerified:true,sourceExpectedHashesMatched:true,
    nativeOwnerConsentRequired:true,changesApplied:false};
}
