// v0.12 stable Linux owner identity for systemd --user sandboxes.
// Identity is an identifier, never a bearer credential or an access grant.
// Preserve native logind/J01 approval and per-pair Tunnel/Worker checks.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const MACHINE_ID='/etc/machine-id';
const UID_MAP='/proc/self/uid_map';
const fail=code=>{throw Object.assign(new Error(code),{code});};

function normalizeUidMap(data,currentUid){
  if(typeof data!=='string'||data.length>2048
    ||!Number.isSafeInteger(currentUid)||currentUid<1||currentUid>4294967294)
    fail('RC012_STABLE_OWNER_UID_MAP_INVALID');
  const lines=data.trim().split(/\r?\n/);
  if(lines.length<1||lines.length>16)
    fail('RC012_STABLE_OWNER_UID_MAP_INVALID');
  let mapped=null,rootInside=null;
  const ranges=[];
  for(const line of lines){
    const m=line.match(/^\s*([0-9]+)\s+([0-9]+)\s+([0-9]+)\s*$/);
    if(!m)fail('RC012_STABLE_OWNER_UID_MAP_INVALID');
    const [inside,outside,count]=m.slice(1).map(Number);
    if([inside,outside,count].some(x=>!Number.isSafeInteger(x))
      ||count<=0||inside>4294967295||outside>4294967295
      ||inside+count>4294967296||outside+count>4294967296)
      fail('RC012_STABLE_OWNER_UID_MAP_INVALID');
    for(const r of ranges){
      if(inside<r.inside+r.count&&r.inside<inside+count
        ||outside<r.outside+r.count&&r.outside<outside+count)
        fail('RC012_STABLE_OWNER_UID_MAP_AMBIGUOUS');
    }
    ranges.push({inside,outside,count});
    if(outside===0)rootInside=inside;
    if(currentUid>=inside&&currentUid<inside+count){
      if(mapped!==null)fail('RC012_STABLE_OWNER_UID_MAP_AMBIGUOUS');
      mapped=outside+(currentUid-inside);
    }
  }
  if(mapped===null||mapped!==currentUid)
    fail('RC012_STABLE_OWNER_UID_NOT_HOST_IDENTITY');
  return {hostUid:mapped,rootInside};
}

export function deriveLinuxHostOwnerSidHash({uid,uidMap,machineId}={}){
  const {hostUid}=normalizeUidMap(uidMap,uid);
  if(typeof machineId!=='string'||!/^[a-f0-9]{32}\n?$/.test(machineId)
    ||/^0{32}\n?$/.test(machineId))
    fail('RC012_STABLE_OWNER_MACHINE_ID_INVALID');
  return createHash('sha256').update(
    'commander.os-owner.sid.v2\0linux\0host-uid='+hostUid
    +'\0machine-id='+machineId.trim()
  ).digest('hex');
}

/**
 * Only OS-controlled local facts. This deliberately does not use an
 * environment variable, YAML field, caller-provided SID or tunnel metadata.
 * A namespace remapping the owner UID to a different host UID fails closed.
 */
/**
 * Root-owned system paths show kernel overflowuid when root is unmapped in
 * a hardened rootless systemd user namespace. Use the OS uid_map and kernel
 * overflowuid, never a caller-supplied or environment-provided UID.
 */
export function readLinuxMappedRootStatUid(){
  if(process.platform!=='linux'||typeof process.getuid!=='function')
    fail('RC012_STABLE_OWNER_LINUX_REQUIRED');
  const uidMap=fs.readFileSync(UID_MAP,'utf8');
  const {rootInside}=normalizeUidMap(uidMap,process.getuid());
  const overflow=Number(fs.readFileSync('/proc/sys/kernel/overflowuid','utf8').trim());
  if(!Number.isSafeInteger(overflow)||overflow<1||overflow>4294967295)
    fail('RC012_STABLE_OWNER_OVERFLOW_UID_INVALID');
  return rootInside===null?overflow:rootInside;
}

export function readLinuxHostOwnerSidHash(){
  if(process.platform!=='linux'||typeof process.getuid!=='function')
    fail('RC012_STABLE_OWNER_LINUX_REQUIRED');
  const uid=process.getuid(),uidMap=fs.readFileSync(UID_MAP,'utf8');
  const expectedRootUid=readLinuxMappedRootStatUid();
  const stat=fs.lstatSync(MACHINE_ID);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==expectedRootUid
    ||(stat.mode&0o022)!==0||stat.size<32||stat.size>34)
    fail('RC012_STABLE_OWNER_MACHINE_ID_UNTRUSTED');
  return deriveLinuxHostOwnerSidHash({
    uid,uidMap,machineId:fs.readFileSync(MACHINE_ID,'utf8')
  });
}

/**
 * Validate a genuine fixed-location system executable even when host UID 0
 * appears as kernel overflowuid inside a hardened rootless user namespace.
 * Every parent from the file to "/" must be non-user-writable and root-owned
 * under the exact current kernel UID mapping.
 */
export function assertTrustedLinuxMappedRootExecutable(file){
  if(typeof file!=='string'||!path.isAbsolute(file)||file.includes('\0'))
    fail('RC012_STABLE_OWNER_EXECUTABLE_UNTRUSTED');
  const rootUid=readLinuxMappedRootStatUid();
  let stat;
  try{stat=fs.lstatSync(file);}
  catch{fail('RC012_STABLE_OWNER_EXECUTABLE_UNAVAILABLE');}
  if(!stat.isFile()||stat.isSymbolicLink()
    ||stat.uid!==rootUid||(stat.mode&0o022)!==0
    ||(stat.mode&0o111)===0)
    fail('RC012_STABLE_OWNER_EXECUTABLE_UNTRUSTED');
  let dir=path.dirname(file);
  while(true){
    let st;
    try{st=fs.lstatSync(dir);}
    catch{fail('RC012_STABLE_OWNER_EXECUTABLE_UNTRUSTED');}
    if(!st.isDirectory()||st.isSymbolicLink()
      ||st.uid!==rootUid||(st.mode&0o022)!==0)
      fail('RC012_STABLE_OWNER_EXECUTABLE_UNTRUSTED');
    const parent=path.dirname(dir);
    if(parent===dir)break;
    dir=parent;
  }
  return true;
}
