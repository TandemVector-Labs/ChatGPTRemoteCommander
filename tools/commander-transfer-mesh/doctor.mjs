#!/usr/bin/env node
// Read-only Commander Transfer Mesh health audit. Never reports Syncthing API keys.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {syncthingDeviceIdFromPem,assertSyncthingRuntimeIdentity} from './device-id.mjs';
const IDS={
 PC:'EFE6R4U-O3B6JVV-N4OKZFL-7X4U24W-A5GFD4G-TM4OPRK-AXBDALA-OCJUBQ6',
 Linux:'6YUIRAM-GDPWPT4-XXX2DD7-K2M7G23-F246XXK-ENQQ3G2-RHIQI2Y-TDRJGAB',
 EmadServer:'YMR5MPK-PW254V4-UX6FHRA-IYBRSN6-BGJMRNO-TTKJGX7-MQEOL3R-LP2VOQF',
 Amirreza:'X6EKTD2-6ZF3WUF-L2AQAHU-VYIQACY-A5BXTIP-F5U5UJE-AT6EREF-2PG6UA6'
};
const defaultRoot=process.platform==='win32'
 ?path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'CommanderTransferPilot')
 :path.join(os.homedir(),'.local','share','commander-transfer-pilot');

// A caller may select a fixture root for tests, but it must resolve below the
// current user's home or the OS temporary directory. Resolve symlinks before
// accepting the root so a friendly-looking path cannot escape those locations.
function resolveDoctorRoot(candidate) {
 const resolved=fs.realpathSync(path.resolve(candidate));
 const allowed=[os.homedir(),os.tmpdir()].map(base=>fs.realpathSync(base));
 if(!allowed.some(base=>resolved.startsWith(base+path.sep)))
  throw new Error('Transfer Mesh root is outside allowed locations');
 return resolved;
}

// Resolve every fixed relative file before reading it. This rejects traversal
// components and symlinks that point outside the accepted root directory.
function readDoctorFile(root,relative) {
 if(path.isAbsolute(relative)||relative.split(/[\\\\/]/).some(part=>!part||part==='.'||part==='..'))
  throw new Error('Invalid Transfer Mesh relative path');
 const target=fs.realpathSync(path.resolve(root,relative));
 if(!target.startsWith(root+path.sep))
  throw new Error('Transfer Mesh file escapes its root directory');
 return fs.readFileSync(target,'utf8');
}

export async function runDoctor({root=defaultRoot,fetchImpl=fetch,writeOutput=console.log}={}) {
 const resolvedRoot=resolveDoctorRoot(root);
const output={schema:'ctmesh-doctor-v1',ok:false,alias:null,version:null,apiStatus:'unavailable',
 activePairCount:0,legacyBroadcastPaused:false,staleMisconfiguredActive:0,connectedPeers:0,transports:{},errors:[]};
function err(e){output.errors.push(String(e?.message||e).slice(0,200).replace(/<apikey>.*?<\/apikey>/ig,'[REDACTED]'));}
try {
 const node=JSON.parse(readDoctorFile(resolvedRoot,'node.json'));
 output.alias=node.alias;
 if(!Object.hasOwn(IDS,node.alias)||node.deviceID!==IDS[node.alias])throw new Error('Node identity mismatch');
 // Verify the installed certificate without executing a binary from the data
 // directory. Cross-check its ID against the running service.
 const id=syncthingDeviceIdFromPem(readDoctorFile(resolvedRoot,'state/cert.pem'));
 if(id!==IDS[node.alias])throw new Error('Certificate identity mismatch');
 const xml=readDoctorFile(resolvedRoot,'state/config.xml');
 const key=xml.match(/<apikey>([^<]+)<\/apikey>/)?.[1];
 if(!key)throw new Error('Local REST key missing');
 const fetchLocal=async(base,url,authenticated=true)=>{
  const h=authenticated?{'X-API-Key':key}:{};
  const r=await fetchImpl(base+url,{headers:h,signal:AbortSignal.timeout(2600)});
  if(!r.ok)throw new Error('Local API HTTP '+r.status);
  return await r.json();
 };
 const candidates=process.platform==='win32'?[8384,18384]:[8384];
 let base;
 for(const port of candidates) {
  const u='http://127.0.0.1:'+port;
  try {const health=await fetchLocal(u,'/rest/noauth/health',false);if(health.status==='OK'){base=u;break;}}catch{}
 }
 if(!base)throw new Error('Local Syncthing REST health unavailable');
 const status=await fetchLocal(base,'/rest/system/status');
 const runtimeVersion=await fetchLocal(base,'/rest/system/version');
 output.version=assertSyncthingRuntimeIdentity(IDS[node.alias],id,status,runtimeVersion);
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
   ||path.resolve(f.path)!==path.resolve(resolvedRoot,'pairs',exp.peerName)){err(new Error('Invalid pair '+exp.id));}
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
writeOutput(JSON.stringify(output));
 return {output,exitCode:output.ok?0:1};
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
 const result=await runDoctor();
 if(result.exitCode!==0)process.exitCode=result.exitCode;
}
