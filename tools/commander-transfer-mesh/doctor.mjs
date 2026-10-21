#!/usr/bin/env node
// Read-only Commander Transfer Mesh health audit. Never reports Syncthing API keys.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {verifySyncthingDaemon,configuredLoopbackRest,pinnedSyncthingJson} from './doctor-rest-identity.mjs';
// Four-host pilot only: the PC launcher has a fixed --gui-address override.
// This is an exact per-node destination, NOT a candidate port scan.
const GUI_OVERRIDES={PC:'127.0.0.1:18384'};
const IDS={
 PC:'EFE6R4U-O3B6JVV-N4OKZFL-7X4U24W-A5GFD4G-TM4OPRK-AXBDALA-OCJUBQ6',
 Linux:'6YUIRAM-GDPWPT4-XXX2DD7-K2M7G23-F246XXK-ENQQ3G2-RHIQI2Y-TDRJGAB',
 EmadServer:'YMR5MPK-PW254V4-UX6FHRA-IYBRSN6-BGJMRNO-TTKJGX7-MQEOL3R-LP2VOQF',
 Amirreza:'X6EKTD2-6ZF3WUF-L2AQAHU-VYIQACY-A5BXTIP-F5U5UJE-AT6EREF-2PG6UA6'
};
const root=process.env.COMMANDER_TRANSFER_HOME || (process.platform==='win32'
 ?path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'CommanderTransferPilot')
 :path.join(os.homedir(),'.local','share','commander-transfer-pilot'));
const output={schema:'ctmesh-doctor-v1',ok:false,alias:null,version:null,apiStatus:'unavailable',
 activePairCount:0,legacyBroadcastPaused:false,staleMisconfiguredActive:0,connectedPeers:0,transports:{},errors:[]};
function err(e){output.errors.push(String(e?.message||e).slice(0,200).replace(/<apikey>.*?<\/apikey>/ig,'[REDACTED]'));}
// Read node identity/config via a bounded verified descriptor. Parent links,
// final symlinks, devices, FIFOs and replacement attempts must fail closed,
// before a configured Syncthing API key is used.
function readVerifiedStateFile(rel,maxBytes){
 const filename=path.join(root,...rel),dir=path.dirname(filename),anchor=path.parse(dir).root;
 let cursor=anchor;
 for(const part of path.relative(anchor,dir).split(path.sep)){
  if(!part||part==='.')continue;
  cursor=path.join(cursor,part);
  const st=fs.lstatSync(cursor);
  if(st.isSymbolicLink()||!st.isDirectory())throw Error('Untrusted doctor state file');
 }
 const named=fs.lstatSync(filename);
 if(!named.isFile()||named.isSymbolicLink()||named.nlink!==1||
    named.size<1||named.size>maxBytes)throw Error('Untrusted doctor state file');
 const flags=fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0)|(fs.constants.O_NONBLOCK??0);
 const fd=fs.openSync(filename,flags);
 try{
  const st=fs.fstatSync(fd);
  if(!st.isFile()||st.nlink!==1||st.size!==named.size||
     st.dev!==named.dev||st.ino!==named.ino)
   throw Error('Untrusted doctor state file');
  const bytes=Buffer.alloc(st.size);
  let at=0;
  while(at<bytes.length){
   const got=fs.readSync(fd,bytes,at,bytes.length-at,at);
   if(got<=0)throw Error('Untrusted doctor state file');
   at+=got;
  }
  const after=fs.fstatSync(fd),namedAfter=fs.lstatSync(filename);
  if(after.dev!==st.dev||after.ino!==st.ino||after.size!==st.size||
     after.mtimeMs!==st.mtimeMs||after.ctimeMs!==st.ctimeMs||
     namedAfter.dev!==st.dev||namedAfter.ino!==st.ino||
     namedAfter.size!==st.size||namedAfter.isSymbolicLink())
   throw Error('Untrusted doctor state file');
  return bytes.toString('utf8');
 }finally{fs.closeSync(fd);}
}
try {
 // Reject network shares and device paths before any potentially blocking I/O.
 if(!path.isAbsolute(root)||
    (process.platform==='win32'&&!/^[A-Za-z]:[\\/]/.test(root)))
   throw Error('Untrusted operator state root namespace');
 const node=JSON.parse(readVerifiedStateFile(['node.json'],16384));
 output.alias=node.alias;
 if(!Object.hasOwn(IDS,node.alias)||node.deviceID!==IDS[node.alias])throw new Error('Node identity mismatch');
 const xml=readVerifiedStateFile(['state','config.xml'],2097152);
 const {base,apiKey:key}=configuredLoopbackRest(xml,GUI_OVERRIDES[node.alias]);
 const fetchLocal=(base,url,authenticated=true)=>
   pinnedSyncthingJson(root,base,key,url,authenticated);
 const health=await fetchLocal(base,'/rest/noauth/health',false);
 if(health.status!=='OK')throw new Error('Configured local Syncthing REST health unavailable');
 // Query the already-authenticated local daemon; never run a binary from a
 // potentially environment-selected installation directory.
 const status=await fetchLocal(base,'/rest/system/status');
 const version=await fetchLocal(base,'/rest/system/version');
 output.version=verifySyncthingDaemon(status,version,IDS[node.alias]);
 const id=status.myID; // identity is accepted only after strict equality verification
 output.apiStatus='OK';
 const folders=await fetchLocal(base,'/rest/config/folders');
 const connected=await fetchLocal(base,'/rest/system/connections');
 const expected=Object.entries(IDS).filter(([name])=>name!==node.alias).map(([name,id])=>({
  id:'ctmesh-v1-'+[node.alias,name].sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase())).join('-').toLowerCase(),
  peerId:id, peerName:name
 }));
 const scoped=folders.filter(f=>f.id?.startsWith('ctmesh-v1-'));
 for(const exp of expected){
  const f=scoped.find(x=>x.id===exp.id);
  if(!f||f.paused||f.devices?.length!==2||new Set(f.devices.map(d=>d.deviceID)).size!==2
   ||!f.devices.some(x=>x.deviceID===id)||!f.devices.some(x=>x.deviceID===exp.peerId)
   ||path.resolve(f.path)!==path.resolve(root,'pairs',exp.peerName)){err(new Error('Invalid pair '+exp.id));}
  else output.activePairCount++;
 }
 output.staleMisconfiguredActive=scoped.filter(f=>!expected.some(x=>x.id===f.id)&&!f.paused).length;
 if(output.staleMisconfiguredActive)err(new Error('Unexpected active shared folders'));
 const broadcast=folders.find(x=>x.id==='ctmesh-pilot-20261013');
 output.legacyBroadcastPaused=broadcast?.paused===true;
 if(!output.legacyBroadcastPaused)err(new Error('Legacy broadcast not paused'));
 for(const [id,info] of Object.entries(connected.connections||{})){
  if(id===IDS[node.alias]||!Object.values(IDS).includes(id)||!info.connected)continue;
  output.connectedPeers++;
  const kind=String(info.type||'unknown');
  output.transports[kind]=(output.transports[kind]||0)+1;
 }
 if(output.activePairCount!==3)err(new Error('Expected exactly three active pairs'));
 output.ok=output.errors.length===0;
}catch(e){err(e);}
console.log(JSON.stringify(output));
if(!output.ok)process.exitCode=1;
