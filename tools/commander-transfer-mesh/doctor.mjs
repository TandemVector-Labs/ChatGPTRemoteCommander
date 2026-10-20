#!/usr/bin/env node
// Read-only Commander Transfer Mesh health audit. Never reports Syncthing API keys.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {verifySyncthingDaemon} from './doctor-rest-identity.mjs';
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
try {
 const node=JSON.parse(fs.readFileSync(path.join(root,'node.json'),'utf8'));
 output.alias=node.alias;
 if(!Object.hasOwn(IDS,node.alias)||node.deviceID!==IDS[node.alias])throw new Error('Node identity mismatch');
 const xml=fs.readFileSync(path.join(root,'state','config.xml'),'utf8');
 const key=xml.match(/<apikey>([^<]+)<\/apikey>/)?.[1];
 if(!key)throw new Error('Local REST key missing');
 const fetchLocal=async(base,url,authenticated=true)=>{
  const h=authenticated?{'X-API-Key':key}:{};
  const r=await fetch(base+url,{headers:h,redirect:'error',signal:AbortSignal.timeout(2600)});
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
