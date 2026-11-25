#!/usr/bin/env node
// Shared, identical Windows/Linux candidate package and rollback engine.
// By design the v0.12 pre-release can execute only in an isolated QA root.
// This engine NEVER starts Core, modifies existing profiles or grants OS access.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import cp from 'node:child_process';
import {fileURLToPath} from 'node:url';

const SCHEMA='rc-universal-qa-v1';
const MARKER='owner-private-qa.json';
const STATE='active.json';
const HASH=/^[0-9a-f]{64}$/;
const SHA=/^[0-9a-f]{40}$/;
const REF=/^[A-Za-z0-9._/-]{1,128}$/;
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const contract=JSON.parse(fs.readFileSync(path.join(root,'installer/universal-install-contract.json'),'utf8'));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const error=x=>{throw Error(x)};
const check=(value,reason)=>{if(!value)error(reason)};
const json=b=>JSON.parse(b);
const read=p=>json(fs.readFileSync(p,'utf8'));
const file=p=>fs.readFileSync(p);
const platform=process.platform==='win32'?'windows':process.platform==='linux'?'linux':'unsupported';
const ownHome=fs.realpathSync(os.homedir());

function options(argv){
  const v={};
  const val=['--bundle','--target','--source','--output','--expected-commit'];
  for(let i=0;i<argv.length;i++){
    const x=argv[i];
    if(x==='--help')return {action:'help'};
    if(['--package','--verify-package','--qa-install','--qa-upgrade','--qa-rollback','--qa-verify','--qa-status','--contract','--verify-suite'].includes(x)){
      check(!v.action,'ACTION_DUPLICATE');v.action=x.slice(2);continue;
    }
    check(val.includes(x)&&i+1<argv.length,'ARGUMENT_INVALID');
    check(!Object.hasOwn(v,x),'ARGUMENT_DUPLICATE');
    v[x]=argv[++i];
  }
  check(v.action,'ACTION_REQUIRED');
  return v;
}
function safeRelative(rel){
  return typeof rel==='string'&&rel.length>0&&rel.length<240&&
    !rel.includes('\\')&&!rel.startsWith('/')&&
    rel.split('/').every(bit=>bit&&bit!=='.'&&bit!=='..'&&
      /^[A-Za-z0-9._+@-]+$/.test(bit));
}
function ensureRegular(p){
  const s=fs.lstatSync(p);
  check(s.isFile()&&!s.isSymbolicLink()&&s.size<=64*1024*1024,'UNTRUSTED_FILE');
  return s;
}
function noAliasParents(p,allowMissing=false){
  let t=path.parse(p).root;
  for(const bit of p.slice(t.length).split(path.sep).filter(Boolean)){
    t=path.join(t,bit);
    if(!fs.existsSync(t)){
      check(allowMissing,'PATH_MISSING');
      continue;
    }
    check(!fs.lstatSync(t).isSymbolicLink(),'PATH_ALIAS_REJECTED');
  }
}
function ensureOwnerQaTarget(raw,create=false){
  check(platform!=='unsupported','PLATFORM_UNSUPPORTED');
  check(typeof raw==='string'&&path.isAbsolute(raw),'QA_ABSOLUTE_TARGET_REQUIRED');
  const target=path.resolve(raw);
  check(target.startsWith(ownHome+path.sep),'QA_TARGET_OUTSIDE_HOME');
  check(/^rc-universal-qa-[a-z0-9-]{4,60}$/i.test(path.basename(target)),'QA_ROOT_NAME_REQUIRED');
  noAliasParents(target,create);
  if(create&&!fs.existsSync(target))fs.mkdirSync(target,{recursive:true,mode:0o700});
  if(fs.existsSync(target)){
    check(fs.lstatSync(target).isDirectory(),'QA_ROOT_NOT_DIRECTORY');
  }
  return target;
}
function validateManifest(m){
  check(m&&typeof m==='object'&&m.schema===SCHEMA&&
    m.product===contract.product&&m.train===contract.sourceTrain&&
    SHA.test(m.sourceCommit)&&/^[0-9]+\.[0-9]+\.[0-9]+-dev\.[1-9][0-9]*$/.test(m.version)&&
    Array.isArray(m.files)&&m.files.length>=100&&m.files.length<=5000&&
    HASH.test(m.digest),'PACKAGE_MANIFEST_INVALID');
  const names=new Set();let size=0;
  for(const x of m.files){
    check(x&&safeRelative(x.path)&&HASH.test(x.sha256)&&
      Number.isSafeInteger(x.bytes)&&x.bytes>=0&&x.bytes<=64*1024*1024,'PACKAGE_FILE_INVALID');
    const key=x.path.toLowerCase();
    check(!names.has(key),'PACKAGE_PATH_COLLISION');names.add(key);
    size+=x.bytes;
  }
  check(size<=512*1024*1024,'PACKAGE_TOO_LARGE');
  const canonical=m.files.map(x=>x.path+'\0'+x.sha256+'\0'+x.bytes+'\n').join('');
  check(sha(canonical)===m.digest,'PACKAGE_DIGEST_MISMATCH');
  check(m.files.every((x,i)=>i===0||m.files[i-1].path<x.path),'PACKAGE_ORDER_INVALID');
}
function listFiles(dir,prefix=''){
  const output=[];
  for(const d of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'))){
    check(!d.isSymbolicLink()&&(d.isDirectory()||d.isFile()),'PACKAGE_LINK_REJECTED');
    const rel=prefix?prefix+'/'+d.name:d.name;
    check(safeRelative(rel),'PACKAGE_FILE_NAME_INVALID');
    if(d.isDirectory())output.push(...listFiles(path.join(dir,d.name),rel));
    else output.push(rel);
  }
  return output;
}
function verifyBundle(dir,expected=''){
  const bundle=path.resolve(dir);
  noAliasParents(bundle);
  const top=fs.readdirSync(bundle).sort();
  check(JSON.stringify(top)===JSON.stringify(['manifest.json','payload']),'PACKAGE_EXTRA_TOPLEVEL_CONTENT');
  ensureRegular(path.join(bundle,'manifest.json'));
  const manifest=read(path.join(bundle,'manifest.json'));
  validateManifest(manifest);
  if(expected)check(manifest.sourceCommit===expected,'EXPECTED_COMMIT_MISMATCH');
  const payload=path.join(bundle,'payload');
  check(fs.lstatSync(payload).isDirectory(),'PAYLOAD_NOT_DIR');
  const actual=listFiles(payload).sort();
  const wanted=manifest.files.map(x=>x.path);
  check(JSON.stringify(actual)===JSON.stringify(wanted),'PACKAGE_FILESET_MISMATCH');
  for(const x of manifest.files){
    const p=path.join(payload,...x.path.split('/'));
    check(ensureRegular(p).size===x.bytes&&sha(file(p))===x.sha256,'PACKAGE_FILE_HASH_MISMATCH');
  }
  return {bundle,manifest};
}
function exec(bin,args,opts={}){
  const r=cp.spawnSync(bin,args,{encoding:'utf8',windowsHide:true,timeout:45000,maxBuffer:12*1024*1024,...opts});
  check(!r.error&&r.status===0,'QA_NATIVE_COMMAND_FAILED_'+bin+':'+String(r.stderr||'').slice(0,160));
  return r.stdout.trim();
}
function pack(opts){
  const source=path.resolve(opts['--source']||root);
  const output=path.resolve(opts['--output']||'');
  const expected=opts['--expected-commit'];
  check(expected&&SHA.test(expected),'EXACT_COMMIT_REQUIRED');
  check(path.isAbsolute(opts['--output']||''),'ABSOLUTE_OUTPUT_REQUIRED');
  check(!fs.existsSync(output),'PACKAGE_OUTPUT_ALREADY_EXISTS');
  noAliasParents(source);
  const got=exec('git',['-C',source,'rev-parse','HEAD']);
  check(got===expected,'SOURCE_COMMIT_DRIFT');
  check(!exec('git',['-C',source,'status','--porcelain']),'SOURCE_DIRTY');
  const version=read(path.join(source,'package.json')).version;
  check(version===read(path.join(source,'docs/release-train-0.12.json')).sourceVersion,
        'RELEASE_TRAIN_VERSION_DRIFT');
  const tmp=output+'.pending-'+process.pid;
  check(!fs.existsSync(tmp),'PACKAGE_STAGE_EXISTS');
  fs.mkdirSync(tmp,{recursive:true,mode:0o700});
  try{
    const archive=path.join(tmp,'source.tar');
    // Canonical Git objects across Windows core.autocrlf=true and Linux false.
    // Pin checkout conversion only for this child process; never change user Git config.
    exec('git',['-c','core.autocrlf=false','-c','core.eol=lf',
               '-C',source,'archive','--format=tar','-o',archive,expected]);
    const payload=path.join(tmp,'payload');
    fs.mkdirSync(payload);
    exec('tar',['-xf',archive,'-C',payload]);
    fs.unlinkSync(archive);
    const paths=listFiles(payload).sort();
    const entries=paths.map(p=>{
      const bytes=file(path.join(payload,...p.split('/')));
      check(bytes.length<=64*1024*1024,'PACKAGE_FILE_TOO_LARGE');
      return {path:p,sha256:sha(bytes),bytes:bytes.length};
    });
    const canonical=entries.map(x=>x.path+'\0'+x.sha256+'\0'+x.bytes+'\n').join('');
    const manifest={
      schema:SCHEMA,product:contract.product,train:contract.sourceTrain,
      sourceCommit:expected,version,serviceChanges:false,fullPowerGrant:false,
      displayParityClaimed:false,files:entries,digest:sha(canonical)
    };
    fs.writeFileSync(path.join(tmp,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
    verifyBundle(tmp,expected);
    fs.renameSync(tmp,output);
    return {status:'QA_PACKAGE_VERIFIED',version,commit:expected,
      files:entries.length,digest:manifest.digest,platform};
  }catch(e){if(fs.existsSync(tmp))fs.rmSync(tmp,{recursive:true,force:true});throw e;}
}
function qaState(target){
  const marker=path.join(target,MARKER);
  check(fs.existsSync(marker),'QA_MARKER_MISSING');
  ensureRegular(marker);
  const ident=read(marker);
  check(ident.schema===SCHEMA&&ident.product===contract.product&&
        ident.qaOnly===true&&ident.target===target,'QA_MARKER_MISMATCH');
  const active=path.join(target,STATE);
  if(!fs.existsSync(active))return null;
  ensureRegular(active);
  const s=read(active);
  check(s.schema===SCHEMA&&
    typeof s.current==='string'&&/^[A-Za-z0-9._-]{5,96}$/.test(s.current)&&
    (s.previous===null||typeof s.previous==='string'&&
      /^[A-Za-z0-9._-]{5,96}$/.test(s.previous)&&s.previous!==s.current)&&
    Number.isSafeInteger(s.revision)&&s.revision>0,'QA_STATE_INVALID');
  return s;
}
function releasePath(target,id){
  check(typeof id==='string'&&/^[A-Za-z0-9._-]{5,96}$/.test(id),'QA_RELEASE_ID_INVALID');
  return path.join(target,'releases',id);
}
function verifyState(target,state){
  if(!state)return {status:'QA_NO_ACTIVE_RELEASE',platform};
  const current=verifyBundle(releasePath(target,state.current));
  if(state.previous)verifyBundle(releasePath(target,state.previous));
  return {status:'QA_ACTIVE_VERIFIED',platform,revision:state.revision,
    current:state.current,previous:state.previous,
    version:current.manifest.version,sourceCommit:current.manifest.sourceCommit,
    digest:current.manifest.digest,realServicesStarted:false,ownerConsentGranted:false};
}
function atomicState(target,state){
  const dest=path.join(target,STATE);
  if(fs.existsSync(dest))ensureRegular(dest);
  const pending=path.join(target,'.active-pending-'+process.pid+'-'+crypto.randomBytes(5).toString('hex'));
  const data=JSON.stringify(state,null,2)+'\n';
  fs.writeFileSync(pending,data,{mode:0o600,flag:'wx'});
  try{
    // Windows FlushFileBuffers requires a writable handle. The already
    // owner-private pending metadata is opened r+ on both OSes, then synced.
    const handle=fs.openSync(pending,'r+');try{fs.fsyncSync(handle)}finally{fs.closeSync(handle)}
    fs.renameSync(pending,dest);
  } finally {if(fs.existsSync(pending))fs.unlinkSync(pending)}
  const fresh=qaState(target);
  check(JSON.stringify(fresh)===JSON.stringify(state),'QA_STATE_READBACK_MISMATCH');
}
function verifyQaRoot(raw){
  const target=ensureOwnerQaTarget(raw);
  qaState(target);
  return target;
}
function qaDeploy(opts){
  const mode=opts.action;
  check(opts['--target'],'QA_TARGET_REQUIRED');
  const target=ensureOwnerQaTarget(opts['--target'],mode==='qa-install');
  if(mode==='qa-install'){
    if(fs.existsSync(path.join(target,MARKER))){
      check(!fs.existsSync(path.join(target,STATE)),'QA_ALREADY_INSTALLED');
      qaState(target);
    }else{
      check(fs.readdirSync(target).length===0,'QA_TARGET_NOT_EMPTY');
      fs.writeFileSync(path.join(target,MARKER),JSON.stringify({
        schema:SCHEMA,product:contract.product,qaOnly:true,target
      })+'\n',{mode:0o600,flag:'wx'});
    }
  }
  const current=qaState(target);
  if(mode==='qa-upgrade')check(current,'QA_UPGRADE_REQUIRES_BASELINE');
  if(mode==='qa-install')check(!current,'QA_FRESH_INSTALL_REQUIRES_EMPTY');
  const expected=opts['--expected-commit'];
  check(expected&&SHA.test(expected),'EXPECTED_COMMIT_REQUIRED');
  const {bundle,manifest}=verifyBundle(opts['--bundle'],expected);
  const release=manifest.version+'-'+manifest.digest.slice(0,16);
  if(current&&release===current.current){
    return {...verifyState(target,current),status:'QA_SAME_PACKAGE_ALREADY_INSTALLED'};
  }
  if(current&&current.previous)error('QA_PREVIOUS_RELEASE_REQUIRES_RETIREMENT');
  const releases=path.join(target,'releases');
  if(!fs.existsSync(releases))fs.mkdirSync(releases,{mode:0o700});
  noAliasParents(releases);
  const dest=releasePath(target,release);
  check(!fs.existsSync(dest),'QA_RELEASE_PATH_COLLISION');
  const temp=path.join(releases,'.stage-'+crypto.randomBytes(10).toString('hex'));
  try{
    fs.cpSync(bundle,temp,{recursive:true,errorOnExist:true,force:false});
    verifyBundle(temp,expected);
    fs.renameSync(temp,dest);
    verifyBundle(dest,expected);
    const state={
      schema:SCHEMA,
      revision:current?current.revision+1:1,
      current:release,previous:current?current.current:null
    };
    atomicState(target,state);
    return {...verifyState(target,qaState(target)),
      status:mode==='qa-install'?'QA_INSTALL_VERIFIED':'QA_UPGRADE_VERIFIED'};
  }catch(e){
    // An abandoned staged release is never an active one. Preserve its bytes
    // for reconciled investigation, not silently promote or delete uncertain state.
    if(fs.existsSync(temp))return {
      status:'QA_STAGE_INCOMPLETE_NO_PROMOTE',error:String(e.message),
      activeUnchanged:!current||JSON.stringify(current)===JSON.stringify(qaState(target))
    };
    throw e;
  }
}
function qaRollback(target){
  const old=qaState(target);
  check(old&&old.previous,'QA_ROLLBACK_UNAVAILABLE');
  verifyState(target,old);
  const next={
    schema:SCHEMA,revision:old.revision+1,
    current:old.previous,previous:old.current
  };
  atomicState(target,next);
  return {...verifyState(target,qaState(target)),status:'QA_ROLLBACK_VERIFIED'};
}
function main(){
  const opts=options(process.argv.slice(2));
  if(opts.action==='help'){
    return {usage:'--package --source ABS --output ABS --expected-commit SHA; --verify-package --bundle ABS; --qa-install|--qa-upgrade --bundle ABS --target HOME/rc-universal-qa-NAME --expected-commit SHA; --qa-verify|--qa-status|--qa-rollback --target ABS; --contract',qaOnly:true};
  }
  if(opts.action==='contract'){
    return {...contract,platform,qaInstallEngineAvailable:true,
      productionInstallEnabled:false,productionRuntimeCutoverAccepted:false};
  }
  if(opts.action==='package')return pack(opts);
  if(opts.action==='verify-package'||opts.action==='verify-suite'){
    check(opts['--bundle'],'PACKAGE_DIR_REQUIRED');
    const {manifest}=verifyBundle(opts['--bundle'],opts['--expected-commit']);
    if(opts.action==='verify-suite'){
      const actual=new Set(manifest.files.map(x=>x.path));
      const missing=contract.requiredSourceFiles.filter(x=>!actual.has(x));
      check(missing.length===0,'SUITE_COMPONENT_FILE_MISSING_'+missing.join(','));
      return {status:'QA_COMMON_SUITE_SOURCE_VERIFIED',platform,
        sourceCommit:manifest.sourceCommit,version:manifest.version,
        files:manifest.files.length,digest:manifest.digest,
        requiredFiles:contract.requiredSourceFiles.length,
        nativeRuntimeVerified:false,visualParityAccepted:false,
        liveDeploymentChanged:false};
    }
    return {status:'QA_PACKAGE_VERIFIED',platform,version:manifest.version,
      sourceCommit:manifest.sourceCommit,files:manifest.files.length,digest:manifest.digest};
  }
  if(opts.action==='qa-install'||opts.action==='qa-upgrade')return qaDeploy(opts);
  check(opts['--target'],'QA_TARGET_REQUIRED');
  const target=verifyQaRoot(opts['--target']);
  if(opts.action==='qa-rollback')return qaRollback(target);
  const current=qaState(target);
  return verifyState(target,current);
}
try{
  console.log(JSON.stringify(main()));
}catch(e){
  console.error(JSON.stringify({status:'QA_UNIFIED_INSTALL_DENIED',reason:String(e.message)}));
  process.exitCode=2;
}
