#!/usr/bin/env node
// Read-only Commander Transfer Mesh health audit. Never reports Syncthing API keys.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {syncthingDeviceIdFromPem,assertSyncthingRuntimeIdentity,isPinnedOptionalMmzPair} from './device-id.mjs';
import {configuredLoopbackRest,fetchPinnedSyncthingJson} from './pinned-rest.mjs';
// Owner-PC Syncthing launcher overrides config.xml GUI port with this fixed value.
const GUI_OVERRIDES={PC:'127.0.0.1:18384'};
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
 if(path.isAbsolute(relative)||relative.split(path.sep).some(part=>!part||part==='.'||part==='..')||relative.split('/').some(part=>!part||part==='.'||part==='..'))
  throw new Error('Invalid Transfer Mesh relative path');
 const target=fs.realpathSync(path.resolve(root,relative));
 if(!target.startsWith(root+path.sep))
  throw new Error('Transfer Mesh file escapes its root directory');
 return fs.readFileSync(target,'utf8');
}

export async function runDoctor({root=defaultRoot,writeOutput=console.log}={}) {
const output={schema:'ctmesh-doctor-v1',ok:false,alias:null,version:null,apiStatus:'unavailable',
 activePairCount:0,optionalPairCount:0,legacyBroadcastPaused:false,staleMisconfiguredActive:0,connectedPeers:0,transports:{},errors:[]};
function err(e){output.errors.push(String(e?.message||e).slice(0,200).replace(/<apikey>.*?<\/apikey>/ig,'[REDACTED]'));}
try {
 const resolvedRoot=resolveDoctorRoot(root);
 const node=JSON.parse(readDoctorFile(resolvedRoot,'node.json'));
 output.alias=node.alias;
 if(!Object.hasOwn(IDS,node.alias)||node.deviceID!==IDS[node.alias])throw new Error('Node identity mismatch');
 // Verify the installed certificate without executing a binary from the data
 // directory. Cross-check its ID against the running service.
 const id=syncthingDeviceIdFromPem(readDoctorFile(resolvedRoot,'state/cert.pem'));
 if(id!==IDS[node.alias])throw new Error('Certificate identity mismatch');
 const xml=readDoctorFile(resolvedRoot,'state/config.xml');
 // A health response never selects an API destination. Bind the endpoint to the
 // configured GUI (or the explicitly pinned PC override), and verify its TLS
 // certificate before sending the API key.
 const {base,apiKey}=configuredLoopbackRest(xml,GUI_OVERRIDES[node.alias]);
 const guiCert=readDoctorFile(resolvedRoot,'state/https-cert.pem');
 const fetchLocal=(route,authenticated=true)=>
   fetchPinnedSyncthingJson(base,route,guiCert,apiKey,authenticated);
 const health=await fetchLocal('/rest/noauth/health',false);
 if(health?.status!=='OK')throw new Error('Configured Syncthing REST health unavailable');
 const status=await fetchLocal('/rest/system/status');
 const runtimeVersion=await fetchLocal('/rest/system/version');
 output.version=assertSyncthingRuntimeIdentity(IDS[node.alias],id,status,runtimeVersion);
 output.apiStatus='OK';
 const folders=await fetchLocal('/rest/config/folders');
 const connected=await fetchLocal('/rest/system/connections');
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
 // The owner MMZ device is an explicitly pinned, optional fourth pair for
 // PC and Linux, not a new compulsory peer on every Core installation.
 // A similarly named untrusted folder/device still fails closed.
 const optionalId=['PC','Linux'].includes(node.alias)
   ?'ctmesh-v1-'+[node.alias,'MMZ'].sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase())).join('-').toLowerCase()
   :null;
 const mmz=optionalId?scoped.find(x=>x.id===optionalId):null;
 if(mmz && !mmz.paused){
  if(isPinnedOptionalMmzPair({alias:node.alias,localDeviceId:id,root:resolvedRoot,folder:mmz}))
    output.optionalPairCount=1;
  else err(new Error('Untrusted optional MMZ pair'));
 }
 output.staleMisconfiguredActive=scoped.filter(f=>!expected.some(x=>x.id===f.id)
  && !(output.optionalPairCount===1 && f.id===optionalId) && !f.paused).length;
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
