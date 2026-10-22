import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const tool=path.join(path.dirname(fileURLToPath(import.meta.url)),'backend-update.mjs');
const candidate=path.join(path.dirname(fileURLToPath(import.meta.url)),'durable-send.mjs');
const shaFile=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// Pins this *source-only candidate* for isolated update/rollback tests.
// The historically field-verified V2 pilot (sha256: 3d7c740fcf8b43bfce4f3a470d286b0de6cc6c59b1aeeeef624381b74c1cca66)
// remains a distinct, unmodified authority in docs/RELEASE_AUTHORITY.md.
// This source hash does not authorize a new host installation.
const expectedCandidate='28af09052b855ce987dc9a2cdfc74ada844c291c7ba0bfec76fe44f44473ef80';
const proc=(...args)=>spawnSync(process.execPath,[tool,...args],{encoding:'utf8',timeout:15000,windowsHide:true});
function fixture(callback){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rc-r16-backend-tx-'));
 const root=path.join(dir,'pilot'),jobs=path.join(root,'jobs','Linux');
 fs.mkdirSync(jobs,{recursive:true});fs.mkdirSync(path.join(root,'staging','Linux'),{recursive:true});
 fs.mkdirSync(path.join(root,'pairs','Linux','transfers'),{recursive:true});
 const old=path.join(root,'durable-send.mjs'),node=path.join(root,'node.json'),journal=path.join(jobs,'synthetic-0001.json');
 fs.writeFileSync(old,"#!/usr/bin/env node\nconsole.log(JSON.stringify({schema:'legacy-r06'}))\n");
 fs.writeFileSync(node,JSON.stringify({schema:'ctmesh-node-v1',alias:'PC'}));
 fs.writeFileSync(journal,JSON.stringify({id:'synthetic-0001',status:'PUBLISHED',bytes:1024}));
 const payload=path.join(root,'pairs','Linux','transfers','archive-original.dat');
 fs.writeFileSync(payload,crypto.randomBytes(1024));
 const oldSha=shaFile(old),newSha=shaFile(candidate),jobSha=shaFile(journal),payloadSha=shaFile(payload);
 const plan=path.join(dir,'update-plan.json'),backup=path.join(dir,'old-backend.backup'),
       applied=path.join(dir,'apply-receipt.json'),rolled=path.join(dir,'rollback-receipt.json');
 const runPlan=()=>proc('plan','--root',root,'--candidate',candidate,'--backup',backup,
                       '--old-sha',oldSha,'--new-sha',newSha,'--out',plan);
 const planDigest=()=>shaFile(plan);
 const apply=()=>proc('apply','--root',root,'--plan',plan,'--sha',planDigest(),'--out',applied);
 const rollback=()=>proc('rollback','--root',root,'--plan',plan,'--sha',planDigest(),'--out',rolled);
 try{return callback({dir,root,old,node,journal,payload,oldSha,newSha,jobSha,payloadSha,plan,backup,applied,rolled,
                        runPlan,planDigest,apply,rollback});}
 finally{
  if(path.basename(dir).startsWith('rc-r16-backend-tx-')&&path.dirname(dir)===os.tmpdir())
   fs.rmSync(dir,{recursive:true,force:true,maxRetries:8,retryDelay:50});
 }
}
const message=r=>(r.stderr||'')+(r.stdout||'');
test('source candidate SHA is pinned and V2 capabilities are available',()=>{
 assert.equal(shaFile(candidate),expectedCandidate);
 const c=spawnSync(process.execPath,[candidate,'capabilities'],{encoding:'utf8',timeout:5000});
 assert.equal(c.status,0,c.stderr);
 const v=JSON.parse(c.stdout);assert.equal(v.contractVersion,2);assert.equal(v.admissionQuotas,true);
});
test('preflight plans without touching backend, journal, config, or existing payload',()=>fixture(f=>{
 const r=f.runPlan();assert.equal(r.status,0,message(r));const j=JSON.parse(r.stdout);
 assert.equal(j.status,'PLAN_PASS_NO_MUTATION');assert.equal(j.jobs,1);
 assert.equal(shaFile(f.old),f.oldSha);assert.equal(shaFile(f.journal),f.jobSha);
 assert.equal(shaFile(f.payload),f.payloadSha);assert.equal(fs.existsSync(f.backup),false);
 assert.equal(fs.existsSync(f.applied),false);
}));
test('atomic activation and exact backup support verified rollback with unchanged queue/data',()=>fixture(f=>{
 assert.equal(f.runPlan().status,0);
 let p=f.apply();assert.equal(p.status,0,message(p));assert.equal(shaFile(f.old),f.newSha);
 assert.equal(shaFile(f.backup),f.oldSha);assert.equal(JSON.parse(fs.readFileSync(f.applied)).status,'APPLIED_IN_OWNER_PILOT_ONLY');
 assert.equal(shaFile(f.journal),f.jobSha);assert.equal(shaFile(f.payload),f.payloadSha);
 const c=spawnSync(process.execPath,[f.old,'capabilities'],{encoding:'utf8',timeout:5000});
 assert.equal(c.status,0,c.stderr);assert.equal(JSON.parse(c.stdout).contractVersion,2);
 p=f.rollback();assert.equal(p.status,0,message(p));assert.equal(shaFile(f.old),f.oldSha);
 assert.equal(shaFile(f.journal),f.jobSha);assert.equal(shaFile(f.payload),f.payloadSha);
 assert.equal(JSON.parse(fs.readFileSync(f.rolled)).status,'ROLLBACK_VERIFIED');
 assert.equal(fs.existsSync(path.join(f.root,'.rc-backend-updater.lock')),false);
}));
test('nonterminal durable job prevents preflight and any archive changes',()=>fixture(f=>{
 fs.writeFileSync(f.journal,JSON.stringify({id:'synthetic-0001',status:'QUEUED',bytes:1024}));
 const r=f.runPlan();assert.notEqual(r.status,0);assert.match(message(r),/JOBS_NOT_TERMINAL/);
 assert.equal(shaFile(f.old),f.oldSha);assert.equal(fs.existsSync(f.plan),false);
}));
test('unknown active lock or unfinished staging part denies preflight',()=>fixture(f=>{
 const lock=path.join(f.root,'jobs','Linux','job.lock');
 fs.writeFileSync(lock,'active');let r=f.runPlan();assert.notEqual(r.status,0);assert.match(message(r),/ACTIVE_OR_UNKNOWN_JOURNAL_FILE/);
 fs.unlinkSync(lock);const part=path.join(f.root,'staging','Linux','job.part');fs.writeFileSync(part,'incomplete');
 r=f.runPlan();assert.notEqual(r.status,0);assert.match(message(r),/ACTIVE_STAGING_FILES/);
 assert.equal(shaFile(f.old),f.oldSha);
}));
test('changed journal after accepted plan blocks application',()=>fixture(f=>{
 assert.equal(f.runPlan().status,0);
 fs.writeFileSync(f.journal,JSON.stringify({id:'synthetic-0001',status:'PUBLISHED',bytes:2048}));
 const r=f.apply();assert.notEqual(r.status,0);assert.match(message(r),/PRESTATE_MISMATCH/);
 assert.equal(shaFile(f.old),f.oldSha);assert.equal(fs.existsSync(f.backup),false);
}));
test('live updater lock after accepted plan blocks apply without changing backend',()=>fixture(f=>{
 assert.equal(f.runPlan().status,0);
 const lock=path.join(f.root,'.rc-backend-updater.lock');fs.writeFileSync(lock,JSON.stringify({pid:process.pid}));
 const r=f.apply();assert.notEqual(r.status,0);assert.match(message(r),/UPDATE_LOCK_PRESENT/);
 assert.equal(shaFile(f.old),f.oldSha);assert.equal(fs.existsSync(f.backup),false);
}));
test('stale or incorrect plan SHA is denied before touching backend',()=>fixture(f=>{
 assert.equal(f.runPlan().status,0);
 const r=proc('apply','--root',f.root,'--plan',f.plan,'--sha','0'.repeat(64),'--out',f.applied);
 assert.notEqual(r.status,0);assert.match(message(r),/PLAN_HASH_MISMATCH/);
 assert.equal(shaFile(f.old),f.oldSha);assert.equal(fs.existsSync(f.backup),false);
}));
test('explicitly reauthorized plan SHA can relocate byte-identical candidate within QA scope',()=>fixture(f=>{
 assert.equal(f.runPlan().status,0);
 const unrelated=path.join(f.dir,'different-v2.mjs');fs.writeFileSync(unrelated,fs.readFileSync(candidate));
 const plan=JSON.parse(fs.readFileSync(f.plan));plan.candidate=unrelated;
 fs.writeFileSync(f.plan,JSON.stringify(plan));
 const r=proc('apply','--root',f.root,'--plan',f.plan,'--sha',shaFile(f.plan),'--out',f.applied);
 // Same bytes remain valid, so this path is allowed; after corrupting a byte it must fail.
 assert.equal(r.status,0,message(r));
 assert.equal(shaFile(f.old),f.newSha);
}));
test('corrupt candidate content after plan fails closed',()=>fixture(f=>{
 assert.equal(f.runPlan().status,0);
 const replacement=path.join(f.dir,'invalid-candidate.mjs');fs.writeFileSync(replacement,'bad');
 const plan=JSON.parse(fs.readFileSync(f.plan));plan.candidate=replacement;
 fs.writeFileSync(f.plan,JSON.stringify(plan));
 const r=proc('apply','--root',f.root,'--plan',f.plan,'--sha',shaFile(f.plan),'--out',f.applied);
 assert.notEqual(r.status,0);assert.match(message(r),/CANDIDATE_CHANGED/);
 assert.equal(shaFile(f.old),f.oldSha);
}));
test('backup is never overwritten if it already exists',()=>fixture(f=>{
 assert.equal(f.runPlan().status,0);
 fs.writeFileSync(f.backup,'other-owner-evidence');
 const r=f.apply();assert.notEqual(r.status,0);assert.match(message(r),/BACKUP_ALREADY_EXISTS/);
 assert.equal(fs.readFileSync(f.backup,'utf8'),'other-owner-evidence');assert.equal(shaFile(f.old),f.oldSha);
}));
test('changing journal after activation blocks rollback rather than discarding new work',()=>fixture(f=>{
 assert.equal(f.runPlan().status,0);assert.equal(f.apply().status,0);
 fs.writeFileSync(f.journal,JSON.stringify({id:'synthetic-0001',status:'PUBLISHED',bytes:4096}));
 const r=f.rollback();assert.notEqual(r.status,0);assert.match(message(r),/PRESTATE_MISMATCH/);
 assert.equal(shaFile(f.old),f.newSha);assert.equal(shaFile(f.backup),f.oldSha);
}));
test('symlinked candidate or node configuration fails closed if OS permits symlinks',(t)=>fixture(f=>{
 const ref=path.join(f.dir,'node-target.json');fs.writeFileSync(ref,fs.readFileSync(f.node));
 try{fs.unlinkSync(f.node);fs.symlinkSync(ref,f.node);}catch(e){if(['EPERM','EACCES'].includes(e.code)){t.skip('Symlink privilege absent');return;}throw e;}
 const r=f.runPlan();assert.notEqual(r.status,0);assert.match(message(r),/UNTRUSTED_FILE/);
 assert.equal(shaFile(f.old),f.oldSha);
}));

test('exact backup supports rollback even if apply receipt was not persisted',()=>fixture(f=>{
 assert.equal(f.runPlan().status,0);
 assert.equal(f.apply().status,0);
 fs.unlinkSync(f.applied); // Simulates a crash after successful atomic rename and before receipt.
 const r=f.rollback();assert.equal(r.status,0,message(r));
 assert.equal(shaFile(f.old),f.oldSha);
 assert.equal(shaFile(f.backup),f.oldSha);
 assert.equal(shaFile(f.journal),f.jobSha);
 assert.equal(shaFile(f.payload),f.payloadSha);
}));
