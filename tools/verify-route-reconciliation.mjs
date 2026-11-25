#!/usr/bin/env node
// Verifies current router state without changing the old updater receipt or any process.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const args=process.argv.slice(2);
const val=n=>{const i=args.indexOf(n);if(i<0||!args[i+1])throw Error('MISSING_'+n);return args[i+1];};
const state=path.resolve(val('--state-root')),repo=path.resolve(val('--repo-dir'));
const profile=val('--profile'),expected=val('--expected-commit').toLowerCase();
const port=Number(val('--canonical-port')),write=args.includes('--write');
if(!/^[\w.-]{1,64}$/.test(profile)||profile.includes('..')||profile[0]==='.')throw Error('PROFILE_INVALID');
if(!/^[0-9a-f]{40}$/.test(expected)||!Number.isInteger(port)||port<1||port>65535)throw Error('IDENTITY_INVALID');
const json=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const file=path.join(state,'routing',profile+'.json');
const before=fs.readFileSync(file,'utf8'),route=JSON.parse(before);
if(route.schema!==1||route.profile!==profile||route?.active?.commit!==expected)throw Error('ROUTE_IDENTITY_INVALID');
if(!Object.hasOwn(route,'previous')||route.previous!==null)throw Error('PREVIOUS_ROUTE_NOT_RETIRED');
if(!Number.isSafeInteger(route.generation)||route.generation<1||!/^[0-9a-f]{64}$/i.test(String(route.active.configSha256??'')))throw Error('ROUTE_EVIDENCE_INVALID');
const head=execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8',timeout:4000}).trim().toLowerCase();
if(head!==expected)throw Error('CONTROL_HEAD_MISMATCH');
try{execFileSync('git',['-C',repo,'diff','--cached','--quiet','--'],{timeout:4000,stdio:'ignore'});}
catch{throw Error('CONTROL_STAGED_DIRTY');}
try{execFileSync('git',['-C',repo,'diff','--ignore-space-at-eol','--quiet','--'],{timeout:4000,stdio:'ignore'});}
catch{throw Error('CONTROL_TRACKED_DIRTY');}
const retained=path.join(state,'retained-backends.json');
if(fs.existsSync(retained)){
 const r=json(retained);
 if(r.schema!==1||!Array.isArray(r.items)||r.items.some(x=>x.profile===profile))throw Error('RETAINED_BACKEND_UNRESOLVED');
}
const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),3000);
let health;
try{
 const response=await fetch('http://127.0.0.1:'+port+'/health',{signal:controller.signal,redirect:'error'});
 if(!response.ok)throw Error('HEALTH_HTTP_FAILED');
 health=await response.json();
}finally{clearTimeout(timer);}
if(health.ok!==true||health.version!==route.active.version||health.instance?.profile!==profile||health.configSha256!==route.active.configSha256)throw Error('HEALTH_IDENTITY_MISMATCH');
if(fs.readFileSync(file,'utf8')!==before)throw Error('ROUTE_CHANGED_DURING_CHECK');
const last=path.join(state,'last-update.json');
const previousReceipt=fs.existsSync(last)?String(json(last).status??''):null;
const proof={schema:1,status:'ROUTE_RECONCILED',profile,commit:expected,generation:route.generation,
 version:route.active.version,configSha256:route.active.configSha256,canonicalPort:port,
 canonicalHealthy:true,previousUpdaterStatus:previousReceipt,verifiedAt:new Date().toISOString(),
 limitation:'This validates router/health/control and previous=null, not old process-tree retirement.'};
if(write){
 const dest=path.join(state,'update-logs','route-reconciliations.json');
 const doc=fs.existsSync(dest)?json(dest):{schema:1,profiles:{}};
 if(doc.schema!==1||!doc.profiles||typeof doc.profiles!=='object'||Array.isArray(doc.profiles))throw Error('PROOF_STORE_INVALID');
 const was=doc.profiles[profile];
 if(!was||was.commit!==proof.commit||was.generation!==proof.generation||was.configSha256!==proof.configSha256||was.canonicalPort!==proof.canonicalPort){
  doc.profiles[profile]=proof;fs.mkdirSync(path.dirname(dest),{recursive:true});
  const temp=dest+'.tmp-'+process.pid;
  try{fs.writeFileSync(temp,JSON.stringify(doc,null,2)+'\n',{flag:'wx',mode:0o600});fs.renameSync(temp,dest);}
  finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
 }
}
process.stdout.write(JSON.stringify(proof)+'\n');
