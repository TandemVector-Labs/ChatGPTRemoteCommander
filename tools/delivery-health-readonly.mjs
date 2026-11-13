#!/usr/bin/env node
// Aggregated active-profile delivery health. STRICTLY READ-ONLY. Never ACK, compact,
// reclassify, claim, or reveal correlation IDs, payloads, artifact contents or paths.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';

const fail=code=>{throw Error(code);};
const isWithin=(root,item)=>item.startsWith(root+path.sep);
function regularFile(file) {
  const st=fs.lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size<2||st.size>64*1024*1024)
    fail('DELIVERY_HEALTH_FILE_INVALID');
  return st;
}
function deliveryDirectory(root,configured,scope) {
  if(typeof configured!=='string'||!path.isAbsolute(configured))
    fail('DELIVERY_HEALTH_PATH_INVALID');
  const absolute=path.resolve(configured);
  const privateBase=path.join(os.homedir(),'.chatgpt-remote-commander','delivery');
  const privateExact=path.join(privateBase,scope);
  if(!isWithin(root,absolute) && absolute!==privateExact)
    fail('DELIVERY_HEALTH_OUTSIDE_TRUSTED_DELIVERY_ROOT');
  // Resolve ALL ancestors, not merely the final directory. Otherwise an
  // allowed-looking state-relative path can traverse a parent symlink outside
  // the authorized state root while its last component remains a real folder.
  const resolved=fs.realpathSync(absolute);
  if(resolved!==absolute)
    fail('DELIVERY_HEALTH_LINKED_STORAGE');
  if(absolute===privateExact){
    for(const x of [path.dirname(privateBase),privateBase,absolute]){
      const st=fs.lstatSync(x);
      if(!st.isDirectory()||st.isSymbolicLink())
        fail('DELIVERY_HEALTH_UNTRUSTED_PRIVATE_ROOT');
    }
  }else if(!isWithin(root,resolved)){
    fail('DELIVERY_HEALTH_OUTSIDE_STATE');
  }
  return absolute;
}
function readJson(file) {
  const st=regularFile(file);
  if(st.size>1024*1024)fail('DELIVERY_HEALTH_METADATA_TOO_LARGE');
  return JSON.parse(fs.readFileSync(file,'utf8'));
}
function scopedPath(root,file) {
  if(typeof file!=='string'||!path.isAbsolute(file))fail('DELIVERY_HEALTH_PATH_INVALID');
  const full=path.resolve(file);
  if(!isWithin(root,full))fail('DELIVERY_HEALTH_OUTSIDE_STATE');
  const real=fs.realpathSync(full);
  if(real!==full||!isWithin(root,real))fail('DELIVERY_HEALTH_LINKED_METADATA');
  return full;
}
const states=['COMPLETED_UNDELIVERED','DELIVERY_PENDING','DELIVERED','TRANSPORT_RECEIPT','DEAD_LETTER'];
function counters(rows) {
  const out=Object.fromEntries(states.map(x=>[x,0]));
  for(const row of rows) {
    if(!Object.hasOwn(out,row.state))fail('DELIVERY_HEALTH_UNEXPECTED_STATE');
    out[row.state]=row.n;
  }
  return out;
}
function pairs(rows) {
  const result={};
  for(const row of rows)result[row.category]=row.n;
  return result;
}
export function readDeliveryHealth({stateRoot,profile,expectedActiveCommit,now=Date.now()}){
  // POSIX 0600 mode is necessary to verify private active-profile DB access.
  // Windows ACLs cannot be proven from fs.stat().mode: never silently treat
  // Windows' emulated POSIX bits as private ACL enforcement.
  if(process.platform!=='linux')fail('DELIVERY_HEALTH_LINUX_ONLY');
  if(typeof stateRoot!=='string'||!path.isAbsolute(stateRoot)||
     !/^[A-Za-z0-9_-]{1,64}$/.test(profile??'')||
     !/^[0-9a-f]{40}$/.test(expectedActiveCommit??'')||
     !Number.isFinite(now))fail('DELIVERY_HEALTH_ARGUMENT');
  const root=fs.realpathSync(stateRoot);
  const route=readJson(scopedPath(root,path.join(root,'routing',profile+'.json')));
  if(route.schema!==1||route.profile!==profile||
    route.active?.commit!==expectedActiveCommit||route.previous!==null)
    fail('DELIVERY_HEALTH_ROUTE_DRIFT');
  const config=readJson(scopedPath(root,route.active.configPath));
  if(config.instance?.profile!==profile)fail('DELIVERY_HEALTH_PROFILE_DRIFT');
  const delivery=config.durableDelivery??{};
  if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(delivery.scope??''))
    fail('DELIVERY_HEALTH_SCOPE_INVALID');
  const directory=deliveryDirectory(root,delivery.directory,delivery.scope);
  if(fs.lstatSync(directory).isSymbolicLink())fail('DELIVERY_HEALTH_SYMLINK');
  const dbPath=path.join(directory,'delivery.sqlite');
  const st=regularFile(dbPath);
  if((st.mode&0o077)!==0)fail('DELIVERY_HEALTH_DB_PERMISSIONS');
  const db=new DatabaseSync(dbPath,{readOnly:true,allowExtension:false,timeout:1000});
  try {
    db.exec('PRAGMA query_only=ON; BEGIN;');
    try{
      const check=db.prepare('PRAGMA quick_check').get();
      if(check?.quick_check!=='ok')fail('DELIVERY_HEALTH_DB_INTEGRITY');
      const scope=delivery.scope;
      const counts=counters(db.prepare(
        'SELECT state,count(*) AS n FROM deliveries WHERE scope=? GROUP BY state'
      ).all(scope));
      const pending=counts.COMPLETED_UNDELIVERED+counts.DELIVERY_PENDING;
      const ages=db.prepare(`SELECT min(created_at) oldest,max(created_at) newest
        FROM deliveries WHERE scope=? AND state IN ('COMPLETED_UNDELIVERED','DELIVERY_PENDING')`).get(scope);
      const bySource=pairs(db.prepare(`SELECT
         CASE WHEN json_extract(payload,'$.source')='operation' THEN 'operation'
              WHEN json_extract(payload,'$.source')='project' THEN 'project'
              ELSE 'other' END AS category,count(*) n
         FROM deliveries WHERE scope=? AND state IN ('COMPLETED_UNDELIVERED','DELIVERY_PENDING')
         GROUP BY category`).all(scope));
      const byKind=pairs(db.prepare(`SELECT
        CASE WHEN json_extract(payload,'$.kind') IN ('COMPLETED','FAILED','CANCELLED','UNCERTAIN','BLOCKED')
             THEN json_extract(payload,'$.kind') ELSE 'other' END AS category,count(*) n
        FROM deliveries WHERE scope=? AND state IN ('COMPLETED_UNDELIVERED','DELIVERY_PENDING')
        GROUP BY category`).all(scope));
      const attemptCounts=db.prepare(`SELECT
        sum(CASE WHEN attempts=0 THEN 1 ELSE 0 END) AS neverClaimed,
        sum(CASE WHEN attempts>=1 THEN 1 ELSE 0 END) AS attempted
        FROM deliveries WHERE scope=? AND state IN ('COMPLETED_UNDELIVERED','DELIVERY_PENDING')`).get(scope);
      const eligible=db.prepare(`SELECT count(*) AS n FROM deliveries WHERE scope=?
        AND state='COMPLETED_UNDELIVERED' AND attempts=0
        AND correlation LIKE 'transport-%' AND event_key LIKE 'operation:%'
        AND json_extract(payload,'$.source')='operation'`).get(scope).n;
      const unfinished=db.prepare(
        "SELECT count(*) AS n FROM requests WHERE scope=? AND status='RUNNING'"
      ).get(scope).n;
      if(ages.oldest!==null && !Number.isFinite(Date.parse(ages.oldest)))
        fail('DELIVERY_HEALTH_TIMESTAMP_INVALID');
      const oldestAgeHours=ages.oldest===null?null:
        Math.max(0,Math.round((now-Date.parse(ages.oldest))/3600000));
      const result={
        status:'READ_ONLY_AGGREGATE',schema:1,profile,activeSourceMatches:true,
        integrity:'ok',databaseBytes:st.size,counts,pending,
        oldestPendingCreatedAt:ages.oldest??null,newestPendingCreatedAt:ages.newest??null,
        oldestPendingAgeHours:oldestAgeHours,pendingBySource:bySource,pendingByKind:byKind,
        pendingNeverClaimed:attemptCounts.neverClaimed??0,
        pendingAttempted:attemptCounts.attempted??0,
        strictTransportReclassificationEligible:eligible,unfinishedRequests:unfinished,
        identityBoundary:'TRUSTED_PROFILE_NOT_AUTHENTICATED_CHAT',
        deliveryAcknowledgedByThisReport:false,mutationPerformed:false,
        caveat:'No authenticated chat identity; pending completion does not prove active work or valid recipient delivery.'
      };
      db.exec('COMMIT');
      return result;
    }catch(error){db.exec('ROLLBACK');throw error;}
  }finally{db.close();}
}
function main(args) {
  if(args.length!==6)fail('DELIVERY_HEALTH_ARGUMENT');
  const values={};
  for(let i=0;i<args.length;i+=2){
    const key=args[i];
    if(!['--state-root','--profile','--expected-active-commit'].includes(key)||key in values)
      fail('DELIVERY_HEALTH_ARGUMENT');
    values[key]=args[i+1];
  }
  return readDeliveryHealth({
    stateRoot:values['--state-root'],profile:values['--profile'],
    expectedActiveCommit:values['--expected-active-commit']
  });
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(main(process.argv.slice(2))));}
  catch(e){
    const code=String(e?.message??'');
    console.error(/^DELIVERY_HEALTH_[A-Z0-9_]+$/.test(code)?code:'DELIVERY_HEALTH_FAILED');
    process.exitCode=1;
  }
}
