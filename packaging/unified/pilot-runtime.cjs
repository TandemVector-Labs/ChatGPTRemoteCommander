'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const sha256=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const expectDirectory=p=>{
  const s=fs.lstatSync(p);
  if(!s.isDirectory()||s.isSymbolicLink())throw Error('UNIFIED_PATH_NOT_DIRECTORY');
};
const safeTree=p=>{
  expectDirectory(p);
  for(const item of fs.readdirSync(p,{withFileTypes:true})){
    const at=path.join(p,item.name);
    if(item.isSymbolicLink())throw Error('UNIFIED_SYMLINK_REFUSED');
    if(item.isDirectory())safeTree(at);
    else if(!item.isFile())throw Error('UNIFIED_SPECIAL_FILE_REFUSED');
  }
};
function validateCore(coreDir){
  expectDirectory(coreDir);
  const m=JSON.parse(fs.readFileSync(path.join(coreDir,'source-manifest.json'),'utf8'));
  if(m.schema!==2 || !/^[a-f0-9]{40}$/.test(m.head||'') ||
      !/^[a-f0-9]{40}$/.test(m.tree||'') ||
      !Number.isInteger(m.count) || m.count<10 ||
      !m.files || typeof m.files!=='object' || Array.isArray(m.files))
    throw Error('UNIFIED_SOURCE_IDENTITY_INVALID');
  const fileNames=Object.keys(m.files);
  if(fileNames.length!==m.count ||
     !['src/server-v0.3.mjs','package.json','config.json'].every(f=>fileNames.includes(f)))
    throw Error('UNIFIED_SOURCE_MANIFEST_INCOMPLETE');
  const expected=new Set();
  for(const [rel,hash] of Object.entries(m.files)){
    if(typeof rel!=='string' || rel.includes('\\') ||
      rel.startsWith('/') || rel.split('/').some(x=>!x||x==='.'||x==='..') ||
      !/^[a-f0-9]{64}$/.test(hash))
      throw Error('UNIFIED_SOURCE_MANIFEST_INVALID');
    const p=path.join(coreDir,...rel.split('/'));
    const stat=fs.lstatSync(p);
    if(!stat.isFile() || stat.isSymbolicLink() || sha256(p)!==hash)
      throw Error('UNIFIED_SOURCE_HASH_MISMATCH '+rel);
    expected.add(rel);
  }
  function checkTree(dir,rel=''){
    for(const e of fs.readdirSync(dir,{withFileTypes:true})){
      const current=rel?rel+'/'+e.name:e.name;
      if(e.isSymbolicLink())throw Error('UNIFIED_CORE_SYMLINK '+current);
      if(!rel && current==='var'){
        if(!e.isDirectory())throw Error('UNIFIED_CORE_VAR_NOT_DIRECTORY');
        continue; // Core writes only runtime data here; never execute from this directory.
      }
      if(e.isDirectory())checkTree(path.join(dir,e.name),current);
      else if(e.isFile()){
        if(current==='source-manifest.json' || current==='.unified-source.json')continue;
        if(!expected.delete(current))throw Error('UNIFIED_CORE_UNEXPECTED_FILE '+current);
      }else throw Error('UNIFIED_CORE_SPECIAL '+current);
    }
  }
  checkTree(coreDir);
  if(expected.size)throw Error('UNIFIED_CORE_MISSING_FILES '+[...expected].slice(0,2).join(','));
  const pkg=JSON.parse(fs.readFileSync(path.join(coreDir,'package.json'),'utf8'));
  if(!/^0\.12\.0-dev\.[1-9][0-9]*$/.test(pkg.version))throw Error('UNIFIED_SOURCE_VERSION_MISMATCH');
  return m;
}
// Preview runtime data are bounded and isolated from production profiles.
// Upgrade only validated Core source, with one retained rollback slot.
const MAX_PREVIEW_RUNTIME_BYTES=4*1024*1024;
const MAX_PREVIEW_CORE_BYTES=48*1024*1024;
function boundedCoreBytes(dir,manifest){
  let bytes=0;
  for(const rel of Object.keys(manifest.files)){
    bytes+=fs.lstatSync(path.join(dir,...rel.split('/'))).size;
    if(bytes>MAX_PREVIEW_CORE_BYTES)throw Error('UNIFIED_PREVIEW_CORE_TOO_LARGE_FOR_AUTOMATIC_COPY');
  }
  return bytes;
}
function ownedCore(dir){
  const manifest=validateCore(dir);
  boundedCoreBytes(dir,manifest);
  const marker=JSON.parse(fs.readFileSync(path.join(dir,'.unified-source.json'),'utf8'));
  if(marker.head!==manifest.head || marker.tree!==manifest.tree)
    throw Error('UNIFIED_CORE_MARKER_MISMATCH');
  return manifest;
}
function boundedPreviewRuntime(oldCore){
  const root=path.join(oldCore,'var');
  if(!fs.existsSync(root))return null;
  let bytes=0;
  function measure(dir){
    expectDirectory(dir);
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      const at=path.join(dir,entry.name);
      if(entry.isSymbolicLink())throw Error('UNIFIED_RUNTIME_SYMLINK_REFUSED');
      if(entry.isDirectory())measure(at);
      else if(entry.isFile()){
        const size=fs.lstatSync(at).size;
        bytes+=size;
        if(bytes>MAX_PREVIEW_RUNTIME_BYTES)
          throw Error('UNIFIED_RUNTIME_DATA_TOO_LARGE_FOR_AUTOMATIC_UPGRADE');
      }else throw Error('UNIFIED_RUNTIME_SPECIAL_FILE_REFUSED');
    }
  }
  measure(root);
  return root;
}
function recoverPreviewSlots(target,rollback,retired,incoming){
  const exists=p=>fs.existsSync(p);
  if(exists(retired)){
    ownedCore(retired);
    if(exists(target)&&exists(rollback)){
      ownedCore(target);ownedCore(rollback);
      fs.rmSync(retired,{recursive:true,force:false});
    }else if(exists(target)&&!exists(rollback)){
      ownedCore(target);
      fs.renameSync(retired,rollback);
    }else if(!exists(target)&&exists(rollback)){
      ownedCore(rollback);
      fs.renameSync(rollback,target);
      fs.renameSync(retired,rollback);
    }else throw Error('UNIFIED_UPGRADE_RECOVERY_AMBIGUOUS');
  }
  if(!exists(target)&&exists(rollback)){
    ownedCore(rollback);
    fs.renameSync(rollback,target);
  }
  if(exists(incoming)){
    ownedCore(incoming);
    fs.rmSync(incoming,{recursive:true,force:false});
  }
}
function preparePreviewCore(source,userData){
  safeTree(source);
  const manifest=validateCore(source);
  boundedCoreBytes(source,manifest);
  fs.mkdirSync(userData,{recursive:true,mode:0o700});
  expectDirectory(userData);
  const parent=path.join(userData,'runtime');
  fs.mkdirSync(parent,{recursive:true,mode:0o700});
  expectDirectory(parent);
  const target=path.join(parent,'core');
  const rollback=path.join(parent,'core.rollback');
  const retired=path.join(parent,'.core-rollback-retired');
  const incoming=path.join(parent,'.core-incoming');
  recoverPreviewSlots(target,rollback,retired,incoming);
  const previous=fs.existsSync(target)?ownedCore(target):null;
  if(previous && previous.head===manifest.head && previous.tree===manifest.tree)
    return {target,head:manifest.head,existing:true,upgraded:false};
  // Preserve the existing tree and runtime data until a complete replacement
  // is validated. These are small preview fixtures, not live owner profiles.
  const oldRuntime=previous?boundedPreviewRuntime(target):null;
  if(fs.existsSync(rollback))ownedCore(rollback);
  try{
    fs.cpSync(source,incoming,{recursive:true,force:false,errorOnExist:true});
    fs.writeFileSync(path.join(incoming,'.unified-source.json'),
      JSON.stringify({head:manifest.head,tree:manifest.tree})+'\n',{flag:'wx',mode:0o600});
    if(oldRuntime)fs.cpSync(oldRuntime,path.join(incoming,'var'),
      {recursive:true,force:false,errorOnExist:true});
    ownedCore(incoming);
  }catch(e){
    if(fs.existsSync(incoming))fs.rmSync(incoming,{recursive:true,force:true});
    throw e;
  }
  if(!previous){
    fs.renameSync(incoming,target);
    return {target,head:manifest.head,existing:false,upgraded:false};
  }
  let archivedRollback=false,archivedCurrent=false;
  try{
    if(fs.existsSync(rollback)){
      fs.renameSync(rollback,retired);
      archivedRollback=true;
    }
    fs.renameSync(target,rollback);
    archivedCurrent=true;
    fs.renameSync(incoming,target);
  }catch(e){
    // A failed rename must never strand the old valid current Core.
    if(archivedCurrent && !fs.existsSync(target) && fs.existsSync(rollback))
      fs.renameSync(rollback,target);
    if(archivedRollback && !fs.existsSync(rollback) && fs.existsSync(retired))
      fs.renameSync(retired,rollback);
    if(fs.existsSync(incoming))ownedCore(incoming);
    throw e;
  }
  let cleanupPending=false;
  if(archivedRollback){
    try{ownedCore(retired);fs.rmSync(retired,{recursive:true,force:false});}
    catch{cleanupPending=true;}
  }
  return {target,head:manifest.head,existing:false,upgraded:true,
    previousHead:previous.head,rollbackRetained:true,cleanupPending};
}
function previewConfig(coreDir,userData,port){
  if(!Number.isInteger(port)||port<1024||port>65535)throw Error('UNIFIED_PREVIEW_PORT');
  const isolated=path.join(userData,'preview');
  fs.mkdirSync(isolated,{recursive:true,mode:0o700});
  const base=JSON.parse(fs.readFileSync(path.join(coreDir,'config.json'),'utf8'));
  base.host='127.0.0.1';base.port=port; base.allowedRoots=[isolated];
  base.allowedPrograms=[];base.autoUpdate={enabled:false};
  base.auditLog=path.join(isolated,'audit.jsonl');
  base.powerMode={enabled:false,fullFilesystem:false,allowShell:false,
    allowProcessControl:false,allowPermanentDelete:false,
    guiControl:{enabled:false},browserControl:{enabled:false}};
  base.capabilityProfile={tier:'STANDARD'};
  base.requireTrustedIngress=false;
  const file=path.join(isolated,'preview-config.json');
  fs.writeFileSync(file,JSON.stringify(base,null,2)+'\n',{mode:0o600});
  return {file,root:isolated};
}
module.exports={validateCore,preparePreviewCore,previewConfig};
