// Read-only deployment preflight. Never installs, uninstalls, grants access,
// reads credentials, or authorizes release. One shared path for Windows/Linux.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';

const expectedPackage='chatgpt-remote-commander';
// Release identity must be derived from the same canonical source used by the
// unified GUI/native package. Reject an inconsistent or unrecognized train.
export function candidateNativeDebianVersion(sourceVersion,guiVersion){
  if(typeof sourceVersion!=='string'||sourceVersion!==guiVersion||
     !/^0\.12\.0-dev\.[1-9][0-9]*$/.test(sourceVersion))return null;
  return sourceVersion.replace('-dev.','~dev.');
}
function readCandidateNativeDebianVersion(){
  try{
    const source=JSON.parse(fs.readFileSync(new URL('../../package.json',import.meta.url),'utf8'));
    const gui=JSON.parse(fs.readFileSync(new URL('./package.json',import.meta.url),'utf8'));
    return candidateNativeDebianVersion(source.version,gui.version);
  }catch{return null;}
}
const safeUnit=/^chatgpt-remote-commander[a-z0-9@._:-]*\.service$/i;
export function isLinuxMigrationUnit(unit,profileName=null){
  if(typeof unit!=='string')return false;
  if(safeUnit.test(unit))return true;
  return typeof profileName==='string'
    &&/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profileName)
    &&profileName!=='.'&&profileName!=='..'
    &&unit===profileName+'-tunnel.service';
}
// Discover *observed* legacy owner Tunnel units by their own service/executable
// identity. This is inventory only: a legacy Tunnel is never accepted as a
// package-native executable or authorized for cutover.
export function isLinuxOwnerCommanderLegacyTunnelUnit({
  unit,execStart,fragmentPath,home
}={}){
  if(typeof unit!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}-tunnel\.service$/.test(unit)
    ||typeof home!=='string'||!path.posix.isAbsolute(home)
    ||typeof execStart!=='string'||typeof fragmentPath!=='string')return false;
  if(fragmentPath!==path.posix.join(home,'.config','systemd','user',unit))return false;
  const command=/^\{ path=([^ ;]+) ; argv\[\]=([^;]+) ;/.exec(execStart);
  if(!command)return false;
  const root=path.posix.join(home,'.local','share','ChatGPTRemoteCommander','tools')+'/';
  const executable=command[1];
  if(!executable.startsWith(root)||!/^tunnel-client-v[0-9]+\.[0-9]+\.[0-9]+-linux-[a-z0-9_-]+\/tunnel-client$/
    .test(executable.slice(root.length)))return false;
  const name=unit.slice(0,-'-tunnel.service'.length);
  return command[2].trim()===executable+' run --profile '+name;
}
const sha=s=>createHash('sha256').update(s).digest('hex').slice(0,16);
// The owner-selected tunnel profile is input, not a ChatGPT identity proof.
// Never print/retain the YAML: it may contain the runtime API key.
export function parseMainTunnelBinding(yaml){
  if(typeof yaml!=='string'||Buffer.byteLength(yaml,'utf8')>16384)return null;
  const lines=yaml.split(/\r?\n/);
  let inMcp=false,inUrls=false,inMain=false,seenMain=0;
  const targets=[];
  for(const line of lines){
    if(/^(?:#.*|\s*)$/.test(line))continue;
    if(/^\S/.test(line)){
      inMcp=/^mcp:\s*(?:#.*)?$/.test(line);
      inUrls=false;inMain=false;continue;
    }
    if(!inMcp)continue;
    if(/^ {2}server_urls:\s*(?:#.*)?$/.test(line)){
      inUrls=true;inMain=false;continue;
    }
    if(/^ {2}[a-zA-Z][\w.-]*:/.test(line)){
      inUrls=false;inMain=false;continue;
    }
    if(!inUrls)continue;
    const channel=/^ {4}- channel:\s*([a-zA-Z0-9._-]+)\s*$/.exec(line);
    if(channel){
      inMain=channel[1]==='main';
      if(inMain)seenMain++;
      continue;
    }
    if(inMain){
      const raw=/^ {6}url:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))\s*$/.exec(line);
      if(raw)targets.push(raw[1]??raw[2]??raw[3]);
    }
  }
  if(seenMain!==1||targets.length!==1)return null;
  let url;
  try{url=new URL(targets[0]);}catch{return null;}
  const port=Number(url.port);
  if(!['http:','https:'].includes(url.protocol)||url.hostname!=='127.0.0.1'
    ||url.pathname!=='/mcp'||url.search||url.hash
    ||url.username||url.password||!Number.isSafeInteger(port)
    ||port<1024||port>65535)return null;
  return Object.freeze({port,channel:'main',path:'/mcp',tls:url.protocol==='https:'});
}
// Bounded descriptor-bound observation: no path reopen after validation.
function readObservedProfile(file,directory,initial,parent){
  const maxBytes=16384;
  const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size
    &&a.mode===b.mode&&a.uid===b.uid&&a.nlink===b.nlink
    &&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
  const invalid=()=>new Error('PROFILE_OBSERVATION_CHANGED');
  let fd;
  try{
    const flags=fs.constants.O_RDONLY
      |(process.platform==='linux'?(fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK):0);
    fd=fs.openSync(file,flags);
    const opened=fs.fstatSync(fd);
    if(!opened.isFile()||opened.nlink!==1||opened.size<1||opened.size>maxBytes
      ||!same(initial,opened)||!same(parent,fs.lstatSync(directory)))throw invalid();
    const buffer=Buffer.alloc(opened.size+1);
    let offset=0;
    while(offset<buffer.length){
      const count=fs.readSync(fd,buffer,offset,buffer.length-offset,offset);
      if(count===0)break;
      offset+=count;
    }
    if(offset!==opened.size||!same(opened,fs.fstatSync(fd))
      ||!same(opened,fs.lstatSync(file))||!same(parent,fs.lstatSync(directory)))
      throw invalid();
    return buffer.subarray(0,offset).toString('utf8');
  }catch{throw invalid();}
  finally{if(fd!==undefined)fs.closeSync(fd);}
}
export function readWindowsOwnerTunnelBinding({
  appData=process.env.APPDATA,profileName='chatgpt-remote-commander'
}={}){
  if(typeof profileName!=='string'
    ||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profileName)
    ||profileName==='.'||profileName==='..'
    ||typeof appData!=='string'||!path.isAbsolute(appData))
    return {profilePresent:false,valid:false};
  const directory=path.join(appData,'tunnel-client');
  const file=path.join(directory,profileName+'.yaml');
  try{
    // A linked parent can redirect a regular-looking YAML file outside the
    // owner's tunnel configuration without making the YAML itself a symlink.
    const parent=fs.lstatSync(directory);
    if(!parent.isDirectory()||parent.isSymbolicLink())
      return {profilePresent:true,valid:false};
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size<1||stat.size>16384)
      return {profilePresent:true,valid:false};
    const binding=parseMainTunnelBinding(readObservedProfile(file,directory,stat,parent));
    return {profilePresent:true,valid:!!binding,port:binding?.port??null,tls:binding?.tls??false};
  }catch(error){
    if(error?.code==='ENOENT')return {profilePresent:false,valid:false};
    return {profilePresent:true,valid:false};
  }
}
/**
 * Read only the one owner-local Linux Tunnel main-channel profile, whatever
 * its chosen name. Profile bytes, names and credentials never leave this
 * process. Ambiguous/misowned/linked profiles are not authorized evidence.
 */
export function readLinuxOwnerTunnelBinding({
  home=process.env.HOME,ownerUid=process.getuid?.(),profileName=null
}={}){
  // A profile selector is observation only, never evidence of owner identity
  // or authorization for the active Tunnel, J01 or release promotion.
  if(profileName!==null&&(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profileName)
    ||profileName==='.'||profileName==='..'))
    return {profilePresent:false,valid:false};
  if(typeof home!=='string'||!path.isAbsolute(home))
    return {profilePresent:false,valid:false};
  const directory=path.join(home,'.config','tunnel-client');
  let names,dir;
  try{
    dir=fs.lstatSync(directory);
    if(!dir.isDirectory()||dir.isSymbolicLink()
      ||(ownerUid!==undefined&&(dir.uid!==ownerUid||(dir.mode&0o077)!==0)))
      return {profilePresent:true,valid:false};
    names=fs.readdirSync(directory).filter(v=>/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.yaml$/.test(v));
  }catch(error){
    if(error?.code==='ENOENT')return {profilePresent:false,valid:false};
    return {profilePresent:true,valid:false};
  }
  if(names.length===0)return {profilePresent:false,valid:false};
  if(profileName===null&&names.length!==1)
    return {profilePresent:true,valid:false};
  const selected=profileName===null?names[0]:profileName+'.yaml';
  if(!names.includes(selected))return {profilePresent:true,valid:false};
  const file=path.join(directory,selected);
  try{
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1
      ||stat.size<1||stat.size>16384
      ||(ownerUid!==undefined&&(stat.uid!==ownerUid||(stat.mode&0o077)!==0)))
      return {profilePresent:true,valid:false};
    const binding=parseMainTunnelBinding(readObservedProfile(file,directory,stat,dir));
    return {profilePresent:true,valid:!!binding,
      port:binding?.port??null,tls:binding?.tls??false};
  }catch{return {profilePresent:true,valid:false};}
}
/**
 * Independently prove an encrypted, owner-local private profile backup.
 * This is a SCOPED YAML restore proof only, not tunnel route, service, grant
 * or release authority. Do not read YAML plaintext or secret keys in Node:
 * only sha256sum and systemd-creds -> sha256sum children access the bytes.
 * Invalid receipts/permissions/symlinks/name mismatches fail closed.
 */
// Canonical six-file same-owner recovery capsule from the universal installer.
// A passing Verify is an independently decryptable *profile-only* receipt:
// never a Core, service, J01 or release-promotion grant. The existing native
// recovery implementation performs a bounded, owner-private disposable restore
// and removes it before returning. No operational files are modified.
// Do not mistake the older opt-in YAML-only receipt for this newer capsule.
function verifyLinuxSixFileOwnerCapsule({home,ownerUid,profileName}){
 const valid=typeof profileName==='string'
  &&/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profileName)
  &&profileName!=='.'&&profileName!=='..';
 if(!valid||typeof home!=='string'||!path.isAbsolute(home)
   ||!Number.isSafeInteger(ownerUid)||ownerUid<0)return false;
 const parent=path.join(home,'.local','state','chatgpt-remote-commander','owner-recovery');
 const canonical=path.join(home,'.config','tunnel-client','chatgpt-remote-commander.yaml');
 const explicit=path.join(parent,'rc012-native-pair-systemd-creds-'+profileName);
 const legacy=profileName==='Emad'&&!fs.existsSync(canonical)
  ?path.join(parent,'rc012-native-pair-systemd-creds'):null;
 const useLegacy=!fs.existsSync(explicit)&&legacy!==null&&fs.existsSync(legacy);
 const directory=useLegacy?legacy:explicit;
 const pair=profileName==='chatgpt-remote-commander'
  ||(profileName==='Emad'&&!fs.existsSync(canonical))?'default':profileName;
 const entries=[
  'tunnel-client/'+profileName+'.yaml',
  ...['ca.crt','client.crt','client.key','server.crt','server.key']
   .map(name=>'chatgpt-remote-commander/private-pair/'+pair+'/'+name)
 ];
 const config=path.join(home,'.config');
 const digest=file=>{
  const p=spawnSync('/usr/bin/sha256sum',[file],{encoding:'utf8',timeout:5000,
    maxBuffer:1024,stdio:['ignore','pipe','ignore']});
  return p.status===0?/^([a-f0-9]{64})\s/.exec(p.stdout||'')?.[1]??null:null;
 };
 const ownedDirectory=dir=>{
  const st=fs.lstatSync(dir);
  return st.isDirectory()&&!st.isSymbolicLink()&&st.uid===ownerUid
    &&(st.mode&0o077)===0&&fs.realpathSync(dir)===path.resolve(dir);
 };
 const ownedFile=(file,max)=>{
  const st=fs.lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1
    ||st.uid!==ownerUid||(st.mode&0o077)!==0
    ||st.size<1||st.size>max)return null;
  return st;
 };
 const same=(f,old)=>{
  const n=fs.lstatSync(f);
  return n.dev===old.dev&&n.ino===old.ino
    &&n.size===old.size&&n.mtimeMs===old.mtimeMs
    &&n.ctimeMs===old.ctimeMs;
 };
 try{
  if(!ownedDirectory(parent)||!ownedDirectory(directory))return false;
  const receipt=path.join(directory,'receipt');
  const cipher=path.join(directory,'owner-pair.cred');
  const r=ownedFile(receipt,256),c=ownedFile(cipher,262144);
  if(!r||!c)return false;
  const match=/^RC012_USER_CREDS_V1\n([a-f0-9]{64})\n([a-f0-9]{64})\n$/
    .exec(fs.readFileSync(receipt,'utf8'));
  if(!match||digest(cipher)!==match[2])return false;
  if(!ownedDirectory(path.join(config,'tunnel-client'))
    ||!ownedDirectory(path.join(config,'chatgpt-remote-commander','private-pair',pair)))
    return false;
  const files=entries.map((name,i)=>{
    const file=path.join(config,...name.split('/'));
    return {file,name,stat:ownedFile(file,i===0?16384:65536)};
  });
  if(files.some(x=>!x.stat)
    ||files.reduce((sum,x)=>sum+x.stat.size,0)>524288)return false;
  const baseline=createHash('sha256');
  for(const {file,name} of files){
    const hash=digest(file);
    if(!hash)return false;
    baseline.update(name+':'+hash+'\n');
  }
  if(baseline.digest('hex')!==match[1])return false;
  const script=path.join(path.dirname(fileURLToPath(import.meta.url)),
    'owner-systemd-creds-profile-recovery.sh');
  const args=useLegacy?['Verify']:['Verify','--profile-name='+profileName];
  const result=spawnSync('/bin/bash',[script,...args],{
    encoding:'utf8',timeout:45000,maxBuffer:256,
    env:{...process.env,HOME:home},stdio:['ignore','pipe','ignore']
  });
  return result.status===0
    &&result.stdout?.trim()==='RC012_LINUX_OWNER_CREDS_VERIFY_PASS_files_6'
    &&same(receipt,r)&&same(cipher,c)
    &&files.every(({file,stat})=>same(file,stat));
 }catch{return false;}
}

export function verifyLinuxPrivateProfileBackup({
  home=process.env.HOME,ownerUid=process.getuid?.(),profileName=null,
  recoveryDir=process.env.REMOTE_COMMANDER_OWNER_PROFILE_RECOVERY
}={}){
  const validName=typeof profileName==='string'
    &&/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profileName)
    &&profileName!=='.'&&profileName!=='..';
  if(!validName||typeof home!=='string'||!path.isAbsolute(home))return false;
  if(recoveryDir===undefined)
    return verifyLinuxSixFileOwnerCapsule({home,ownerUid,profileName});
  if(typeof recoveryDir!=='string'||!path.isAbsolute(recoveryDir))return false;
  // A raw string prefix is not containment: /home/owner/../other still
  // passes it before fs.realpathSync touches the escaped directory.
  // Validate lexical and normalized containment before any filesystem I/O.
  const ownerRoot=path.resolve(home);
  const recoveryRoot=path.resolve(recoveryDir);
  const child=path.relative(ownerRoot,recoveryRoot);
  if(!child||child==='..'||child.startsWith('..'+path.sep)
    ||path.isAbsolute(child)||recoveryDir.split(path.sep).includes('..'))return false;
  const fixedReceipt='rc012-owner-private-profile-backups-verified.json';
  const encryptedName='tunnel-profile-'+profileName+'-owner-restorable.cred';
  const expectedCredentialName=profileName+'-profile-v012';
  const source=path.join(home,'.config','tunnel-client',profileName+'.yaml');
  const receipt=path.join(recoveryDir,fixedReceipt);
  const encrypted=path.join(recoveryDir,encryptedName);
  const ownedFile=(file,maxSize)=>{
    try{
      const meta=fs.lstatSync(file);
      return meta.isFile()&&!meta.isSymbolicLink()&&meta.nlink===1
        &&(ownerUid===undefined||meta.uid===ownerUid)
        &&(meta.mode&0o077)===0&&meta.size>0&&meta.size<=maxSize
        ?meta:null;
    }catch{return null;}
  };
  const unchanged=(file,initial)=>{
    try{
      const end=fs.lstatSync(file);
      return end.dev===initial.dev&&end.ino===initial.ino
        &&end.size===initial.size&&end.mtimeMs===initial.mtimeMs;
    }catch{return false;}
  };
  try{
    // Resolve/verify the whole parent path: symlinked recovery directories
    // cannot redirect backup inspection outside the owner home.
    if(fs.realpathSync(recoveryDir)!==path.resolve(recoveryDir))return false;
    const folder=fs.lstatSync(recoveryDir);
    if(!folder.isDirectory()||folder.isSymbolicLink()
      ||(ownerUid!==undefined&&folder.uid!==ownerUid)
      ||(folder.mode&0o077)!==0)return false;
    const rstat=ownedFile(receipt,16384);
    const sstat=ownedFile(source,16384);
    const cstat=ownedFile(encrypted,65536);
    if(!rstat||!sstat||!cstat)return false;
    const info=JSON.parse(fs.readFileSync(receipt,'utf8'));
    const item=info?.profiles?.[profileName];
    if(info?.schema!==1
      ||info?.scope!=='MMZ_HOST_THREE_OWNER_PRIVATE_TUNNEL_YAML_ROLLBACK_ONLY'
      ||info.sameHostEncryptedRestoreProven!==true||!item
      ||item.backupFile!==encryptedName
      ||item.credentialName!==expectedCredentialName
      ||item.encryption!=='systemd-creds-user-host-non-null'
      ||item.sourceBytes!==sstat.size||item.cipherBytes!==cstat.size
      ||!/^[a-f0-9]{64}$/.test(item.sourceSha256)
      ||!/^[a-f0-9]{64}$/.test(item.ciphertextSha256))return false;
    const fileHash=(file)=>{
      const result=spawnSync('/usr/bin/sha256sum',[file],{
        encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:1024,
        stdio:['ignore','pipe','ignore']});
      const digest=/^([a-f0-9]{64})\s/.exec(result.stdout||'');
      return result.status===0?digest?.[1]??null:null;
    };
    if(fileHash(source)!==item.sourceSha256
      ||fileHash(encrypted)!==item.ciphertextSha256)return false;
    const script='set -o pipefail; /usr/bin/systemd-creds decrypt --user --refuse-null --name="$1" "$2" - | /usr/bin/sha256sum | /usr/bin/cut -d " " -f1';
    // Root-owned executables only; script source travels on stdin, never argv.
    const proof=spawnSync('/bin/bash',['-s','--',expectedCredentialName,encrypted],{
      input:script,encoding:'utf8',windowsHide:true,timeout:8000,maxBuffer:1024,
      stdio:['pipe','pipe','ignore']});
    const value=proof.stdout?.trim();
    const restored=proof.status===0&&/^[0-9a-f]{64}$/.test(value)?value:null;
    return restored===item.sourceSha256
      &&unchanged(receipt,rstat)&&unchanged(source,sstat)
      &&unchanged(encrypted,cstat);
  }catch{return false;}
}

function probeLoopbackCoreVersion(port){
  if(!Number.isSafeInteger(port)||port<1024||port>65535)return null;
  // Isolated bounded local GET. Never forwards the tunnel credential.
  const script=String.raw`
const http=require('node:http');
const port=Number(process.argv[1]);
let body='';
const req=http.get({hostname:'127.0.0.1',port,path:'/health',timeout:1200},res=>{
  if(res.statusCode!==200){res.resume();process.exitCode=2;return;}
  res.setEncoding('utf8');
  res.on('data',chunk=>{body+=chunk;if(body.length>2048)req.destroy();});
  res.on('end',()=>{try{
    const obj=JSON.parse(body);
    if(typeof obj.version==='string'&&/^0\.(?:11|12)\.[A-Za-z0-9.-]+$/.test(obj.version))
      process.stdout.write(obj.version);
    else process.exitCode=2;
  }catch{process.exitCode=2;}});
});
req.on('timeout',()=>req.destroy());
req.on('error',()=>{process.exitCode=2;});
`;
  const result=exec(process.execPath,['-e',script,String(port)]);
  const version=result.stdout.trim();
  return result.ok && /^0\.(?:11|12)\.[A-Za-z0-9.-]+$/.test(version)
    ?version:null;
}

function exec(program,args){
  try{
    const r=spawnSync(program,args,{encoding:'utf8',windowsHide:true,timeout:7000,
      maxBuffer:512*1024,stdio:['ignore','pipe','pipe']});
    return {ok:r.status===0,stdout:r.stdout||'',status:r.status};
  }catch{return {ok:false,stdout:'',status:null};}
}
export function assessMigration(facts){
  if(!facts||!['linux','win32'].includes(facts.platform))throw Error('RC012_MIGRATION_PLATFORM_INVALID');
  if(facts.connectionMode!==undefined&&!['private-tunnel','managed-oauth'].includes(facts.connectionMode))
    throw Error('RC012_MIGRATION_CONNECTION_MODE_INVALID');
  const privateTunnel=facts.connectionMode==='private-tunnel';
  const blocked=[];
  const oldPresent=facts.platform==='win32'
    ?facts.legacyInnoPresent===true||facts.nativeUnifiedNsisPresent===true
    :facts.nativePackageInstalled===true;
  const units=Array.isArray(facts.units)?facts.units:[];
  if(!facts.inventoryReliable)blocked.push('INVENTORY_UNAVAILABLE');
  if(facts.platform==='win32'&&facts.routerDetected===true
    &&facts.routerMappingMatches!==true)
    blocked.push('OWNER_STABLE_ROUTER_BACKEND_MISMATCH');
  // The existing Stable Router uses HTTP input and HTTP forwarding. It cannot
  // terminate tunnel-client mTLS or pass verified TLS peer identity to G1.
  // Changing only its backend port would silently preserve legacy plaintext.
  if(!privateTunnel&&facts.platform==='win32'&&facts.routerDetected===true)
    blocked.push('G1_STABLE_ROUTER_PLAINTEXT_MTLS_INCOMPATIBLE');
  if(!privateTunnel&&facts.platform==='win32'&&facts.tunnelProfilePresent===true
    &&facts.tunnelProfileValid===true&&facts.tunnelTargetTls!==true)
    blocked.push('G1_TUNNEL_HTTPS_MTLS_ROUTE_REQUIRED');
  // PRIVATE mode uses the SAME exclusive Tunnel with an owner-pinned local
  // HTTPS/mTLS server. A healthy plaintext Router or an upgraded backend
  // version does not authenticate the local tunnel client or J01 owner.
  // This describes URL-based main-channel bindings, not the separate stdio
  // transport, which requires its own admission contract.
  if(privateTunnel&&facts.tunnelProfilePresent===true
    &&facts.tunnelProfileValid!==true)
    blocked.push('OWNER_TUNNEL_MAIN_BINDING_UNVERIFIED');
  if(privateTunnel&&facts.tunnelProfilePresent===true
    &&facts.tunnelProfileValid===true&&facts.tunnelTargetTls!==true)
    blocked.push('PRIVATE_TUNNEL_HTTPS_MTLS_ROUTE_REQUIRED');
  if(privateTunnel&&facts.routerDetected===true)
    blocked.push('PRIVATE_STABLE_ROUTER_MTLS_INCOMPATIBLE');
  if(facts.tunnelProfilePresent===true){
    if(facts.tunnelProfileValid!==true)
      blocked.push('OWNER_TUNNEL_MAIN_BINDING_UNVERIFIED');
    else if(facts.tunnelTargetTls!==true
      &&(typeof facts.tunnelTargetVersion!=='string'
        ||!facts.tunnelTargetVersion.startsWith('0.12.')))
      blocked.push('OWNER_TUNNEL_STILL_TARGETS_LEGACY_OR_UNKNOWN_CORE');
  }
  if(facts.platform==='win32' && oldPresent){
    if(facts.nativeUnifiedNsisPresent===true&&facts.legacyInnoPresent!==true){
      if(facts.ownerRegisteredInstallerFamily==='unified-nsis')
        blocked.push('UNIFIED_NSIS_OWNER_UPGRADE_ROLLBACK_UNVERIFIED');
      else blocked.push('OWNER_INSTALLER_IDENTITY_UNVERIFIED');
    }else if(facts.ownerRegisteredInstallerFamily==='owner-managed-powershell')
      blocked.push('OWNER_MANAGED_TO_UNIFIED_NSIS_TRANSACTION_MISSING');
    else {
      blocked.push('LEGACY_INNO_TO_NSIS_TRANSACTION_MISSING');
      if(['unverified','multiple-or-unverified'].includes(facts.ownerRegisteredInstallerFamily))
        blocked.push('OWNER_INSTALLER_IDENTITY_UNVERIFIED');
    }
  }
  // A native package version is not the active Core version. Prevent a fleet
  // cutover from silently downgrading/reinstalling an older DEB over a newer
  // installed identity even when a source-pinned QA build otherwise passes.
  if(facts.platform==='linux'&&oldPresent){
    if(facts.candidateNativePackageVersionVerified!==true)
      blocked.push('NATIVE_CANDIDATE_VERSION_COMPARISON_UNVERIFIED');
    if(facts.candidateNativePackageDowngrade===true)
      blocked.push('NATIVE_CANDIDATE_PACKAGE_DOWNGRADE_REFUSED');
    else if(facts.candidateNativePackageSameVersion===true)
      blocked.push('NATIVE_CANDIDATE_PACKAGE_SAME_VERSION_REFUSED');
  }
  if(facts.platform==='linux' && oldPresent && !facts.allNativePayloadPathsAvailable)
    blocked.push('NATIVE_RUNTIME_TUNNEL_SERVICE_CONTINUITY_UNPROVEN');
  if(facts.platform==='linux' && oldPresent
    &&facts.nativeProtectedCoreFilesPresent===false)
    blocked.push('NATIVE_PROTECTED_CORE_FILES_NOT_INSTALLED');
  if(facts.platform==='linux' && oldPresent
    &&facts.nativePackageIntegrityVerified===false)
    blocked.push('NATIVE_INSTALLED_PACKAGE_INTEGRITY_UNVERIFIED');
  if(units.some(u=>u.active && !u.knownExecutable))
    blocked.push('ACTIVE_SERVICE_EXECUTABLE_UNMAPPED');
  if(units.some(u=>u.enabled && !u.knownExecutable))
    blocked.push('ENABLED_AUTOSTART_EXECUTABLE_UNMAPPED');
  if(units.some(u=>u.kind==='tunnel' && (u.active||u.enabled) && !u.nativeTunnelCompatible))
    blocked.push('TUNNEL_CUTOVER_UNVERIFIED');
  if(units.some(u=>u.active) && !facts.activeServiceRestoreTested)
    blocked.push('ACTIVE_SERVICE_ROLLBACK_NOT_TESTED');
  if(!facts.profileBackupReceiptVerified)blocked.push('PROFILE_BACKUP_NOT_VERIFIED');
  if(!facts.featureParityVerified)blocked.push('LEGACY_CAPABILITY_PARITY_NOT_PROVEN');
  if(privateTunnel){
    // Per-user Plugin/Tunnel ownership and native ingress boundaries must be
    // positively proven; a loopback URL or a successful tunnel readiness check
    // is not an authenticated pair or an OS Full Access grant.
    if(facts.privatePairBindingVerified!==true)
      blocked.push('PRIVATE_PLUGIN_TUNNEL_PAIR_BINDING_UNVERIFIED');
    if(facts.privateLocalIngressIsolated!==true)
      blocked.push('PRIVATE_TUNNEL_LOOPBACK_ISOLATION_UNVERIFIED');
    if(facts.privateCredentialOwnershipVerified!==true)
      blocked.push('PRIVATE_RUNTIME_CREDENTIAL_OWNERSHIP_UNVERIFIED');
    // The v0.12 worker quarantines privileged /mcp unless an independently
    // authenticated owner-bound ingress is actually wired. Selecting private
    // mode does NOT bypass that runtime guard or grant Full Access.
    if(facts.privatePrivilegedIngressReady!==true)
      blocked.push('PRIVATE_PRIVILEGED_INGRESS_NOT_WIRED');
  }else if(!facts.g1AuthenticatedCurrentSession)
    blocked.push('G1_CURRENT_SESSION_UNVERIFIED');
  if(!facts.j01OwnerNativeConsent)blocked.push('J01_NATIVE_OWNER_CONSENT_UNVERIFIED');
  if(!facts.revocableFullAccessProven)blocked.push('FULL_ACCESS_REVOCATION_UNVERIFIED');
  // Commercial code-signing is optional for the first owner-approved
  // release. An independently pinned manifest AND candidate/rollback hashes
  // provide a verifiable alternative; never accept an artifact's own hash
  // without an owner-pinned trust anchor.
  if(facts.trustedPublisherSignature!==true
    &&facts.ownerPinnedNativeReleaseVerified!==true)
    blocked.push('TRUSTED_RELEASE_PROVENANCE_UNVERIFIED');
  if(facts.signedUpdateRollbackAccepted!==true
    &&facts.ownerPinnedRollbackVerified!==true)
    blocked.push('UPDATE_ROLLBACK_PROVENANCE_UNVERIFIED');
  if(!facts.installedCanaryAccepted)blocked.push('NATIVE_INSTALLED_CANARY_NOT_ACCEPTED');
  // No positive "promotion" operation exists in this tool. Even complete
  // evidence needs the independent release authority and owner acceptance.
  return Object.freeze({schema:1,decision:'NO_PROMOTE',readOnly:true,
    platform:facts.platform,existingInstalled:oldPresent,
    connectionMode:facts.connectionMode??'managed-oauth',
    ownerRegisteredInstallerFamily:facts.platform==='win32'
      ?facts.ownerRegisteredInstallerFamily??'unknown':null,
    nativeUnifiedNsisDetected:facts.platform==='win32'
      ?facts.nativeUnifiedNsisPresent===true:null,
    nativeUnifiedNsisRegistryMatched:facts.platform==='win32'
      ?facts.nativeUnifiedNsisRegistryMatched===true:null,
    ownerTunnelProfileDetected:facts.tunnelProfilePresent===true,
    ownerTunnelTargetPort:facts.tunnelProfileValid===true?facts.tunnelTargetPort??null:null,
    ownerTunnelHttpsConfigured:facts.tunnelProfileValid===true&&facts.tunnelTargetTls===true,
    ownerStableRouterDetected:facts.routerDetected===true,
    ownerStableRouterBackendPort:facts.routerDetected===true?facts.routerBackendPort:null,
    ownerStableRouterBackendVersion:facts.routerDetected===true?facts.routerBackendVersion:null,
    ownerStableRouterMappingMatches:facts.routerDetected===true&&facts.routerMappingMatches===true,
    ownerTunnelTargetRuntimeVersion:facts.tunnelProfileValid===true?facts.tunnelTargetVersion??null:null,
    nativeCandidateVersionComparisonVerified:facts.platform==='linux'
      ?facts.candidateNativePackageVersionVerified===true:null,
    nativeCandidateDowngradeDetected:facts.platform==='linux'
      ?facts.candidateNativePackageDowngrade===true:null,
    nativeCandidateSameVersionDetected:facts.platform==='linux'
      ?facts.candidateNativePackageSameVersion===true:null,
    nativeProtectedCoreFilesPresent:facts.platform==='linux'
      ?facts.nativeProtectedCoreFilesPresent===true:null,
    nativePackageIntegrityVerified:facts.platform==='linux'
      ?facts.nativePackageIntegrityVerified===true:null,
    activeCoreUnits:units.filter(u=>u.kind==='core'&&u.active).length,
    activeTunnelUnits:units.filter(u=>u.kind==='tunnel'&&u.active).length,
    enabledCoreUnits:units.filter(u=>u.kind==='core'&&u.enabled).length,
    enabledTunnelUnits:units.filter(u=>u.kind==='tunnel'&&u.enabled).length,
    unmappedUnits:units.filter(u=>(u.active||u.enabled)&&!u.knownExecutable).length,
    blocked:[...new Set(blocked)],promotionAuthority:'EXTERNAL_REQUIRED'});
}
// Check actual dpkg-owned runtime capability, not just "0.12" package
// metadata. Earlier 0.12 QA packages shipped before Private Core/J01 wiring.
const NATIVE_V012_RUNTIME_FILES=Object.freeze([
 'runtime/node','tunnel/native-tunnel-launch.sh','tunnel/tunnel-client',
 'native-config-preflight.mjs','app/src/server-v0.3.mjs',
 'app/src/v012-private-core-runtime.mjs',
 'app/src/v2-private-pair-mcp-http-ingress.mjs',
 'app/src/v2-private-tunnel-https-gateway.mjs',
 'app/src/v2-private-pair-operation-gate.mjs',
 'app/src/v2-private-signed-worker-grant-adapter.mjs',
 'app/src/v101-private-pair-native-owner-stack.mjs',
 'app/src/native-owner-session-provider-linux.mjs',
 'app/src/native-tunnel-attestor.mjs',
 'app/package.json'
]);
export function inspectLinuxNativeCorePayload(
 nativeRoot='/usr/lib/chatgpt-remote-commander'
){
 if(typeof nativeRoot!=='string'||!path.isAbsolute(nativeRoot))return false;
 try{
  const base=fs.lstatSync(nativeRoot);
  if(!base.isDirectory()||base.isSymbolicLink())return false;
  for(const rel of NATIVE_V012_RUNTIME_FILES){
   const file=path.join(nativeRoot,rel);
   const stat=fs.lstatSync(file);
   // Official bundled Node is ~125 MB; source modules are far smaller.
   // Do not mistake an intact embedded runtime for missing protected Core.
   const maxBytes=rel==='runtime/node'?256*1024*1024
     :rel==='tunnel/tunnel-client'?128*1024*1024
     :48*1024*1024;
   if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1
     ||stat.size>maxBytes
     ||(process.platform==='linux'&&fs.realpathSync(file)!==file))return false;
  }
  const pkg=JSON.parse(fs.readFileSync(path.join(nativeRoot,'app','package.json'),'utf8'));
  return /^0\.12\.0-dev\.[1-9][0-9]*$/.test(pkg?.version??'');
 }catch{return false;}
}
function linuxFacts({profileName=null}={}){
  const packageQuery=exec('dpkg-query',['-W','-f=${Package}|${Version}|${Status}',expectedPackage]);
  const [name,version,status]=packageQuery.stdout.trim().split('|');
  const exists=packageQuery.ok&&name===expectedPackage&&status==='install ok installed';
  const candidateDebVersion=readCandidateNativeDebianVersion();
  // dpkg's own Debian-version comparator is the authority. Do not compare
  // lexical SemVer strings or trust the running 0.11 Core as package metadata.
  const higher=exists&&candidateDebVersion
    ?exec('dpkg',['--compare-versions',version,'gt',candidateDebVersion]):null;
  const equal=exists&&candidateDebVersion
    ?exec('dpkg',['--compare-versions',version,'eq',candidateDebVersion]):null;
  const candidateNativePackageVersionVerified=candidateDebVersion!==null
    &&(!exists||(higher?.status===0||higher?.status===1)
      &&(equal?.status===0||equal?.status===1));
  const units=[];
  // List service names only. Inspect at most 48 scoped candidates and never
  // expose ExecStart, profile IDs, or credential-bearing arguments in output.
  const listing=exec('systemctl',['--user','list-units','--all','--type=service','--no-legend','--plain']);
  const files=exec('systemctl',['--user','list-unit-files','--type=service','--no-legend','--plain']);
  let discoveryComplete=listing.ok&&files.ok;
  if(discoveryComplete){
    const candidate=new Set(),enabled=new Set();
    const consider=unit=>{
      // Template definitions are not installed service instances: systemctl
      // show returns nonzero for them on Linux. Don't invent a fleet blocker.
      if(unit.endsWith('@.service'))return;
      if(isLinuxMigrationUnit(unit,profileName)||/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}-tunnel\.service$/.test(unit))
        candidate.add(unit);
    };
    for(const line of listing.stdout.split(/\r?\n/)){
      const unit=line.trim().split(/\s+/)[0];
      if(unit)consider(unit);
    }
    for(const line of files.stdout.split(/\r?\n/)){
      const [unit,state]=line.trim().split(/\s+/);
      if(!unit)continue;
      consider(unit);
      if(['enabled','enabled-runtime','linked','linked-runtime'].includes(state))enabled.add(unit);
    }
    if(candidate.size>48)discoveryComplete=false;
    for(const name of [...candidate].sort().slice(0,48)){
      const result=exec('systemctl',['--user','show',name,'-p','ActiveState','-p','ExecStart','-p','FragmentPath']);
      if(!result.ok){discoveryComplete=false;continue;}
      const execStart=result.stdout.match(/^ExecStart=(.*)$/m)?.[1]||'';
      const fragmentPath=result.stdout.match(/^FragmentPath=(.*)$/m)?.[1]||'';
      const oldUnit=isLinuxMigrationUnit(name,profileName);
      const legacyTunnel=!oldUnit&&isLinuxOwnerCommanderLegacyTunnelUnit({
        unit:name,execStart,fragmentPath,home:process.env.HOME
      });
      if(!oldUnit&&!legacyTunnel)continue;
      const active=result.stdout.includes('ActiveState=active');
      const nativeTunnel=execStart.includes('/usr/lib/chatgpt-remote-commander/tunnel/native-tunnel-launch.sh');
      const nativeCore=execStart.includes('/usr/lib/chatgpt-remote-commander/runtime/node');
      units.push({id:sha(name),kind:legacyTunnel||name.includes('-tunnel')?'tunnel':'core',
        active,enabled:enabled.has(name),
        knownExecutable:(nativeTunnel||nativeCore)&&!legacyTunnel,
        nativeTunnelCompatible:nativeTunnel&&!legacyTunnel});
    }
  }
  const nativeVersionOK=exists&&/^0\.12\.0~dev/.test(version||'');
  const knownNative=exec('test',['-f','/usr/lib/chatgpt-remote-commander/tunnel/native-tunnel-launch.sh']);
  const nativeProtectedCoreFilesPresent=nativeVersionOK
    &&inspectLinuxNativeCorePayload();
  // Existing dpkg metadata is not proof that installed bytes are intact.
  // Never trust a self-consistent user-edited "v0.12" directory.
  const integrity=exists?exec('dpkg',['-V',expectedPackage]):{ok:false,stdout:''};
  const nativePackageIntegrityVerified=exists&&integrity.ok
    &&integrity.stdout.trim()==='';
  const tunnel=readLinuxOwnerTunnelBinding({profileName});
  const targetVersion=tunnel.valid&&!tunnel.tls
    ?probeLoopbackCoreVersion(tunnel.port):null;
  return {platform:'linux',connectionMode:'private-tunnel',
    inventoryReliable:packageQuery.ok&&discoveryComplete,
    nativePackageInstalled:exists,
    candidateNativePackageVersionVerified,
    candidateNativePackageDowngrade:higher?.status===0,
    candidateNativePackageSameVersion:equal?.status===0,
    nativeProtectedCoreFilesPresent,nativePackageIntegrityVerified,
    allNativePayloadPathsAvailable:nativeVersionOK&&knownNative.ok
      &&nativeProtectedCoreFilesPresent,
    tunnelProfilePresent:tunnel.profilePresent,tunnelProfileValid:tunnel.valid,
    tunnelTargetPort:tunnel.port??null,tunnelTargetTls:tunnel.tls===true,
    tunnelTargetVersion:targetVersion,
    profileBackupReceiptVerified:verifyLinuxPrivateProfileBackup({profileName}),
    units};
}
/** Router mapping is an observation, not authorization to change routing. */
export function classifyObservedRouterStatus(report,listenPort,backendHealthVersion){
  if(!report||typeof report!=='object'||Array.isArray(report)
    ||report.router!==true||report.listenPort!==listenPort
    ||typeof report.sourceSha256!=='string'
    ||!/^[a-f0-9]{64}$/.test(report.sourceSha256)
    ||report.profile!=='default'||report.schema!==1
    ||!Number.isSafeInteger(report.generation)||report.generation<1
    ||!Number.isSafeInteger(report.activePort)
    ||report.activePort<1024||report.activePort>65535
    ||report.activePort===listenPort
    ||typeof report.activeVersion!=='string'
    ||!/^0\.(?:11|12)\.[A-Za-z0-9.-]+$/.test(report.activeVersion))
    return Object.freeze({detected:false,mappingMatches:false});
  const match=backendHealthVersion===report.activeVersion;
  return Object.freeze({detected:true,mappingMatches:match,
    backendPort:report.activePort,backendVersion:report.activeVersion,
    generation:report.generation});
}
function probeLoopbackRouterStatus(port){
  if(!Number.isSafeInteger(port)||port<1024||port>65535)return null;
  // Constrain reading to the local router and emit only whitelisted fields.
  const script=String.raw`
const http=require('node:http');
const port=Number(process.argv[1]);
let body='',bytes=0;
const req=http.get({hostname:'127.0.0.1',port,path:'/router/status',timeout:1200},res=>{
 if(res.statusCode!==200){res.resume();process.exitCode=2;return;}
 res.setEncoding('utf8');
 res.on('data',chunk=>{
   bytes+=Buffer.byteLength(chunk);
   if(bytes>8192){req.destroy();return;}
   body+=chunk;
 });
 res.on('end',()=>{try{
   const raw=JSON.parse(body);
   if(raw.router!==true||!raw.state)throw Error('not_router');
   const state=raw.state;
   process.stdout.write(JSON.stringify({
     router:raw.router,listenPort:raw.listenPort,
     sourceSha256:raw.sourceSha256,
     profile:state.profile,schema:state.schema,
     generation:state.generation,
     activePort:state.active?.port,activeVersion:state.active?.version
   }));
 }catch{process.exitCode=2;}});
});
req.on('timeout',()=>req.destroy());
req.on('error',()=>{process.exitCode=2;});
`;
  const observed=exec(process.execPath,['-e',script,String(port)]);
  if(!observed.ok||observed.stdout.length>1024)return null;
  try{return JSON.parse(observed.stdout);}catch{return null;}
}
/**
 * Registry output is operator-managed untrusted text. Never report the
 * uninstall command, install path, username or arguments; only the family.
 * A script-based uninstaller is NOT proven safe to invoke automatically.
 */
export function classifyWindowsUninstallRegistryResponse(raw){
  if(typeof raw!=='string'||Buffer.byteLength(raw,'utf8')>50000)
    return 'unverified';
  const lines=raw.split(/\r?\n/);
  const matches=lines.map(line=>
    /^\s*UninstallString\s+REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/i.exec(line))
    .filter(Boolean);
  if(matches.length!==1)return 'unverified';
  const command=matches[0][1];
  if(command.length>8192||/[\u0000-\u001f]/.test(command))
    return 'unverified';
  if(/(?:^|[\\/"\s])(?:pwsh|powershell)\.exe"?\s/i.test(command)
    &&/(?:^|\s)-File\s+(?:"[^"]*\\uninstall\.ps1"|[^\s"]*\\uninstall\.ps1)(?:\s|$)/i.test(command))
    return 'owner-managed-powershell';
  if(/(?:^|[\\/"\s])unins\d+\.exe"?\s*$/i.test(command))
    return 'inno-unverified';
  return 'unverified';
}
// electron-builder appId io.tandemvector.commander has one product-wide NSIS
// uninstall registration (not a device-specific key). An owner-registry entry
// is inventory evidence only, NEVER publisher trust or upgrade authorization.
export function classifyWindowsUnifiedNsisRegistryResponse(raw){
  if(typeof raw!=='string'||Buffer.byteLength(raw,'utf8')>32768)return 'unverified';
  const attrs=new Map();
  for(const line of raw.split(/\r?\n/)){
    const m=/^\s*(DisplayName|DisplayVersion|UninstallString)\s+REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/i.exec(line);
    if(!m)continue;
    const key=m[1].toLowerCase();
    if(attrs.has(key))return 'unverified';
    attrs.set(key,m[2]);
  }
  const version=attrs.get('displayversion');
  const title=attrs.get('displayname');
  const command=attrs.get('uninstallstring');
  // Same product identity covers 0.12 stable and future releases, without
  // trusting any uninstaller to execute or interpreting registry as signature.
  const release=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
    .exec(version??'');
  if(!release||version.length>80
    ||(Number(release[1])===0&&Number(release[2])<12)
    ||title!=='Remote Commander '+version
    ||typeof command!=='string'||command.length>8192
    ||/[\u0000-\u001f]/.test(command)
    ||!/(?:^|[\\/])Uninstall Remote Commander\.exe(?:["\s]|$)/i.test(command))
    return 'unverified';
  return 'unified-nsis';
}
export function windowsOwnerDpapiVerifyOutputAccepted(status,stdout){
  return status===0 && typeof stdout==='string'
    && stdout.trim()==='RC012_WINDOWS_OWNER_DPAPI_BACKUP_VERIFY_PASS files=6 encrypted=true originalProfileUnchanged=true actualRestoreNotExecuted=true';
}
export function windowsOwnerDpapiPowerShellExecutable(){
  // The reviewed machine-wide MSI default: never trust caller-controlled
  // ProgramFiles, PATH or another ambient executable discovery source.
  // Non-default installations fail closed instead of running an untrusted exe.
  return path.win32.join('C:\\Program Files','PowerShell','7','pwsh.exe');
}
function verifyWindowsOwnerDpapiBackup(profileName='chatgpt-remote-commander'){
  if(process.platform!=='win32'||typeof profileName!=='string'
    ||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profileName)
    ||profileName==='.'||profileName==='..')return false;
  const appData=process.env.APPDATA;
  if(typeof appData!=='string'||!path.win32.isAbsolute(appData))return false;
  const exe=windowsOwnerDpapiPowerShellExecutable();
  const script=path.join(path.dirname(fileURLToPath(import.meta.url)),
    'owner-dpapi-profile-recovery.ps1');
  try{
    const binary=fs.lstatSync(exe),source=fs.lstatSync(script);
    if(!binary.isFile()||binary.isSymbolicLink()
      ||!source.isFile()||source.isSymbolicLink())return false;
    const result=spawnSync(exe,['-NoLogo','-NoProfile','-NonInteractive',
      '-File',script,'-Mode','Verify','-ProfileName',profileName],{
      encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:1024,
      stdio:['ignore','pipe','ignore']
    });
    return !result.error&&!result.signal
      &&windowsOwnerDpapiVerifyOutputAccepted(result.status,result.stdout);
  }catch{return false;}
}
function windowsFacts({profileName=null}={}){
  const selectedProfile=profileName??'chatgpt-remote-commander';
  if(typeof selectedProfile!=='string'
    ||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(selectedProfile)
    ||selectedProfile==='.'||selectedProfile==='..')
    throw Error('RC012_MIGRATION_PREFLIGHT_PROFILE_INVALID');
  const paths=[
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RemoteCommander',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RemoteCommander',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RemoteCommander'
  ];
  const checks=paths.map(p=>exec('reg.exe',['query',p,'/v','UninstallString']));
  // Fixed product identity from the unified electron-builder appId, the SAME
  // identifier on every Windows owner host. No registry-wide fuzzy scan.
  const nativeNsisId='e8b3b1a5-66f7-5b0b-b5ed-ddf867067934';
  const nativePaths=[
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\'+nativeNsisId,
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\'+nativeNsisId,
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\'+nativeNsisId
  ];
  const native= nativePaths.map(p=>exec('reg.exe',['query',p]));
  // reg.exe exit 1 is an absent fixed key, not evidence about other apps.
  const bad=[...checks,...native].some(c=>c.stdout.length>50000);
  const present=checks.filter(c=>c.ok);
  const nativePresent=native.filter(c=>c.ok);
  const installerFamily=present.length&&nativePresent.length
    ?'multiple-or-unverified'
    :nativePresent.length===1
      ?classifyWindowsUnifiedNsisRegistryResponse(nativePresent[0].stdout)
      :nativePresent.length>1?'multiple-or-unverified'
      :present.length===1?classifyWindowsUninstallRegistryResponse(present[0].stdout)
      :present.length===0?'none':'multiple-or-unverified';
  const tunnel=readWindowsOwnerTunnelBinding({profileName:selectedProfile});
  const targetVersion=tunnel.valid?probeLoopbackCoreVersion(tunnel.port):null;
  const routerReport=tunnel.valid?probeLoopbackRouterStatus(tunnel.port):null;
  const backendVersion=routerReport?.activePort
    ?probeLoopbackCoreVersion(routerReport.activePort):null;
  const route=classifyObservedRouterStatus(routerReport,tunnel.port,backendVersion);
  return {platform:'win32',connectionMode:'private-tunnel',
    legacyInnoPresent:checks.some(c=>c.ok),
    nativeUnifiedNsisPresent:nativePresent.length>0,
    nativeUnifiedNsisRegistryMatched:installerFamily==='unified-nsis',
    ownerRegisteredInstallerFamily:installerFamily,
    inventoryReliable:!bad&&checks.length===3&&native.length===3,
    tunnelProfilePresent:tunnel.profilePresent,tunnelProfileValid:tunnel.valid,
    tunnelTargetPort:tunnel.port??null,tunnelTargetTls:tunnel.tls===true,
    tunnelTargetVersion:targetVersion,
    routerDetected:route.detected,routerMappingMatches:route.mappingMatches,
    routerBackendPort:route.detected?route.backendPort:null,
    routerBackendVersion:route.detected?route.backendVersion:null,
    profileBackupReceiptVerified:verifyWindowsOwnerDpapiBackup(selectedProfile),
    units:[]};
}
export function inspectLocalPlatform(platform=process.platform,{profileName=null}={}){
  if(platform==='linux')return linuxFacts({profileName});
  if(platform==='win32')return windowsFacts({profileName});
  throw Error('RC012_MIGRATION_UNSUPPORTED_PLATFORM');
}
export function localReport(platform=process.platform,options={}){
  const f=inspectLocalPlatform(platform,options);
  return assessMigration(f);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const argv=process.argv.slice(2);
  if(argv.length<1||argv.length>2||argv[0]!=='--read-only')
    throw Error('RC012_MIGRATION_PREFLIGHT_READ_ONLY_ONLY');
  let profileName=null;
  if(argv.length===2){
    if(!['linux','win32'].includes(os.platform())
      ||!argv[1].startsWith('--profile-name='))
      throw Error('RC012_MIGRATION_PREFLIGHT_PROFILE_INVALID');
    profileName=argv[1].slice('--profile-name='.length);
    if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profileName)
      ||profileName==='.'||profileName==='..')
      throw Error('RC012_MIGRATION_PREFLIGHT_PROFILE_INVALID');
  }
  const report=localReport(os.platform(),{profileName});
  process.stdout.write(JSON.stringify(profileName===null?report:
    {...report,ownerProfileName:profileName},null,2)+'\n');
  if(report.blocked.length)process.exitCode=2;
}
