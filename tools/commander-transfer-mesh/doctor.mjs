#!/usr/bin/env node
// Read-only Commander Transfer Mesh health audit. Never reports Syncthing API keys.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const IDS={
 PC:'EFE6R4U-O3B6JVV-N4OKZFL-7X4U24W-A5GFD4G-TM4OPRK-AXBDALA-OCJUBQ6',
 Linux:'6YUIRAM-GDPWPT4-XXX2DD7-K2M7G23-F246XXK-ENQQ3G2-RHIQI2Y-TDRJGAB',
 MMZ:'SHNJRDO-UUT55KW-GKFAAYO-X7QB33A-VNRTY4H-ES3H3PD-KB5TMCW-GSYEDAR',
 EmadServer:'YMR5MPK-PW254V4-UX6FHRA-IYBRSN6-BGJMRNO-TTKJGX7-MQEOL3R-LP2VOQF',
 Amirreza:'X6EKTD2-6ZF3WUF-L2AQAHU-VYIQACY-A5BXTIP-F5U5UJE-AT6EREF-2PG6UA6'
};
const root=process.env.COMMANDER_TRANSFER_HOME || (process.platform==='win32'
 ?path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'CommanderTransferPilot')
 :path.join(os.homedir(),'.local','share','commander-transfer-pilot'));
const output={schema:'ctmesh-doctor-v1',ok:false,alias:null,version:null,apiStatus:'unavailable',
 activePairCount:0,legacyBroadcastPaused:false,staleMisconfiguredActive:0,connectedPeers:0,
 expectedPeers:Object.keys(IDS).length-1,disconnectedPeers:[],connectivityReady:false,transports:{},errors:[]};
function err(e){output.errors.push(String(e?.message||e).slice(0,200).replace(/<apikey>.*?<\/apikey>/ig,'[REDACTED]'));}
export function evaluatePeerConnectivity(connections,alias){
 if(!Object.hasOwn(IDS,alias))throw Error('Unknown local peer');
 const rows=connections?.connections;
 if(!rows||typeof rows!=='object'||Array.isArray(rows))throw Error('Invalid connection response');
 const expected=Object.entries(IDS).filter(([name])=>name!==alias);
 const disconnectedPeers=[],transports={};
 let connectedPeers=0;
 for(const [name,id] of expected){
  const info=rows[id];
  if(info?.connected!==true){disconnectedPeers.push(name);continue;}
  connectedPeers++;
  const kind=String(info.type||'unknown');
  transports[kind]=(transports[kind]||0)+1;
 }
 return {connectedPeers,expectedPeers:expected.length,disconnectedPeers,transports,
  allConnected:disconnectedPeers.length===0};
}
export function assessDaemonIdentity({status,version,alias}){
 if(!Object.hasOwn(IDS,alias)||typeof status?.myID!=='string'||status.myID!==IDS[alias])
   throw new Error('Certificate identity mismatch');
 const current=version?.version;
 if(typeof current!=='string'||current.length>64
  ||!/^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.+-]{1,48})?$/.test(current))
   throw new Error('Invalid Syncthing version');
 return 'syncthing '+current;
}
async function main(){
try {
 const node=JSON.parse(fs.readFileSync(path.join(root,'node.json'),'utf8'));
 output.alias=node.alias;
 if(!Object.hasOwn(IDS,node.alias)||node.deviceID!==IDS[node.alias])throw new Error('Node identity mismatch');
 const xml=fs.readFileSync(path.join(root,'state','config.xml'),'utf8');
 const key=xml.match(/<apikey>([^<]+)<\/apikey>/)?.[1];
 if(!key)throw new Error('Local REST key missing');
 const fetchLocal=async(base,url,authenticated=true)=>{
  const h=authenticated?{'X-API-Key':key}:{};
  const r=await fetch(base+url,{headers:h,signal:AbortSignal.timeout(2600)});
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
 // Authenticate to the loopback daemon and bind its live certificate identity
 // to the reviewed peer map. A diagnostic never executes a pilot-supplied binary.
 const status=await fetchLocal(base,'/rest/system/status');
 const version=await fetchLocal(base,'/rest/system/version');
 output.version=assessDaemonIdentity({status,version,alias:node.alias});
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
 // A fresh fifth peer has no historical broadcast folder; absence is safe.
 output.legacyBroadcastPaused=!broadcast || broadcast.paused===true;
 if(!output.legacyBroadcastPaused)err(new Error('Legacy broadcast not paused'));
 const connectivity=evaluatePeerConnectivity(connected,node.alias);
 output.connectedPeers=connectivity.connectedPeers;
 output.expectedPeers=connectivity.expectedPeers;
 output.disconnectedPeers=connectivity.disconnectedPeers;
 output.transports=connectivity.transports;
 if(output.activePairCount!==Object.keys(IDS).length-1)err(new Error('Expected exactly '+(Object.keys(IDS).length-1)+' active pairs'));
 output.ok=output.errors.length===0;
 // Configuration health and live reachability are independent acceptance gates.
 output.connectivityReady=output.ok&&connectivity.allConnected;
}catch(e){err(e);}
console.log(JSON.stringify(output));
if(!output.ok)process.exitCode=1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
