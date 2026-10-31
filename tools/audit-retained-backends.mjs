#!/usr/bin/env node
// Read-only retained-backend triage. This tool NEVER retires process/state.
import fs from 'node:fs';
import path from 'node:path';
import {probeOwnedRetainedReferences} from './retained-owned-process-probe.mjs';

function fail(code){throw Error(code);}
const args=process.argv.slice(2);
const value=flag=>{
  const matches=args.map((x,i)=>x===flag?i:-1).filter(i=>i!==-1);
  if(matches.length!==1||!args[matches[0]+1])fail('AUDIT_ARGUMENT');
  return args[matches[0]+1];
};
const withProcessRefs=args.length===7&&args[6]==='--with-process-refs';
if(args.length!==6&&!withProcessRefs)fail('AUDIT_ARGUMENT');
const state=fs.realpathSync(path.resolve(value('--state-root')));
const profile=value('--profile');
const expected=value('--expected-active-commit');
if(!/^[A-Za-z0-9_-]{1,64}$/.test(profile)||!/^[a-f0-9]{40}$/.test(expected))fail('AUDIT_IDENTITY');
const contained=(name,folder)=>{
  const absolute=path.resolve(name);
  const base=path.join(state,folder);
  if(!absolute.startsWith(base+path.sep))fail('AUDIT_PATH_OUTSIDE_STATE');
  return absolute;
};
function read(file) {
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size<2||stat.size>1048576)
    fail('AUDIT_FILE_INVALID');
  return JSON.parse(fs.readFileSync(file,'utf8'));
}
function existsEntry(name) {
  try {fs.lstatSync(name);return true;}
  catch(e){if(e.code==='ENOENT')return false;throw e;}
}
function pidStatus(pid) {
  if(!Number.isSafeInteger(pid)||pid<=1) return 'INVALID';
  try {process.kill(pid,0);return 'ALIVE_OR_UNVERIFIED';}
  catch(e){if(e.code==='ESRCH')return 'DEAD';return 'ALIVE_OR_UNVERIFIED';}
}
const route=read(path.join(state,'routing',profile+'.json'));
if(route.schema!==1||route.profile!==profile||route.active?.commit!==expected||route.previous!==null)
  fail('AUDIT_ACTIVE_ROUTE_MISMATCH');
const registryPath=path.join(state,'retained-backends.json');
const registry=read(registryPath);
if(registry.schema!==1||!Array.isArray(registry.items)||registry.items.length>1024)
  fail('AUDIT_REGISTRY_INVALID');
const result=[],entryPaths=[];
for(let index=0;index<registry.items.length;index++){
  const item=registry.items[index];
  if(item?.profile!==profile)continue;
  const reasons=[];
  const flag=(code)=>{if(!reasons.includes(code))reasons.push(code);};
  if(!/^[a-f0-9]{40}$/.test(item.commit??'')||
    !/^[a-f0-9]{64}$/.test(item.configSha256??'')||
    !Number.isSafeInteger(Number(item.port))||Number(item.port)<1||Number(item.port)>65535)
    fail('AUDIT_RECORD_INVALID');
  if(item.commit===route.active.commit)flag('MATCHES_ACTIVE_COMMIT');
  const release=contained(item.projectDir,'releases');
  const config=contained(item.configPath,'runtimes');
  entryPaths.push([release,config]);
  if(existsEntry(release))flag('RELEASE_STILL_EXISTS');
  if(!Array.isArray(item.terminalPids)||item.terminalPids.length===0)
    flag('TERMINAL_PID_EVIDENCE_MISSING');
  else if(item.terminalPids.some(pid=>pidStatus(pid)!=='DEAD'))
    flag('TERMINAL_PID_ALIVE_OR_UNKNOWN');
  try {
    const c=read(config);
    const marker=contained(c.runtimeState,'runtimes');
    entryPaths.at(-1).push(marker);
    const m=read(marker);
    if(m.projectDir!==release||m.configSha256!==item.configSha256||
       m.version!==item.version||String(m.port)!==String(item.port)||
       m.instance?.profile!==profile)flag('RUNTIME_MARKER_IDENTITY_DRIFT');
    if(pidStatus(m.pid)!=='DEAD')flag('BACKEND_PID_ALIVE_OR_UNKNOWN');
  } catch(e) {
    if(e.message==='AUDIT_PATH_OUTSIDE_STATE')flag('RUNTIME_MARKER_PATH_UNTRUSTED');
    else flag('RUNTIME_MARKER_UNAVAILABLE_OR_INVALID');
  }
  result.push({index,commit:item.commit,port:Number(item.port),
    outcome:reasons.length?'INCONCLUSIVE':'HISTORICAL_TERMINATED_CANDIDATE',
    reasons,action:'OWNER_REVIEW_REQUIRED_NO_AUTOMATIC_RETIREMENT'});
}
let processEvidence=null;
if(withProcessRefs){
  processEvidence=probeOwnedRetainedReferences(entryPaths);
  for(let i=0;i<result.length;i++){
    const refs=processEvidence.refPids[i];
    result[i].ownedProcessRefCount=refs.length;
    if(refs.length||processEvidence.unreadableOwned>0){
      result[i].outcome='INCONCLUSIVE';
      if(refs.length)result[i].reasons.push('SAME_OWNER_PROCESS_REFERENCES_HISTORIC_PATH');
      if(processEvidence.unreadableOwned>0)result[i].reasons.push('OWNED_PROCESS_READ_INCOMPLETE');
    }
  }
}
console.log(JSON.stringify({schema:1,status:'READ_ONLY_RETAINED_AUDIT',profile,
  activeCommit:expected,registryCount:registry.items.length,profileCount:result.length,
  historicalCandidates:result.filter(x=>x.outcome==='HISTORICAL_TERMINATED_CANDIDATE').length,
  inconclusive:result.filter(x=>x.outcome==='INCONCLUSIVE').length,
  processEvidence:processEvidence&&{scope:processEvidence.scope,scanned:processEvidence.scanned,otherUser:processEvidence.otherUser,vanished:processEvidence.vanished,unreadableOwned:processEvidence.unreadableOwned},
  caveat:'PID/path disappearance does not prove no orphan descendants, socket/lease activity or other-owner references; never auto-delete.',
  entries:result}));
