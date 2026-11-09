import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const tool=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../tools/audit-retained-backends.mjs');
const commit='a'.repeat(40),old='b'.repeat(40),sha='c'.repeat(64);
function fixture(t) {
 const state=fs.mkdtempSync(path.join(os.tmpdir(),'rc-retained-readonly-'));
 t.after(()=>fs.rmSync(state,{recursive:true,force:true}));
 fs.mkdirSync(path.join(state,'routing'),{recursive:true});
 fs.writeFileSync(path.join(state,'routing','default.json'),JSON.stringify({
  schema:1,profile:'default',generation:123,active:{commit,version:'0.10.25'},previous:null
 }));
 const runtimeDir=path.join(state,'runtimes',old,'default');
 fs.mkdirSync(runtimeDir,{recursive:true});
 const config=path.join(runtimeDir,'config.json'),marker=path.join(runtimeDir,'mcp-runtime.json');
 const project=path.join(state,'releases','v0.9.4-'+old.slice(0,12));
 fs.writeFileSync(config,JSON.stringify({runtimeState:marker}));
 const m={pid:999999999,projectDir:project,configSha256:sha,version:'0.9.4',port:48832,instance:{profile:'default'}};
 fs.writeFileSync(marker,JSON.stringify(m));
 const entry={profile:'default',version:'0.9.4',port:48832,commit:old,configSha256:sha,
  configPath:config,projectDir:project,terminalPids:[999999998]};
 const retained=path.join(state,'retained-backends.json');
 fs.writeFileSync(retained,JSON.stringify({schema:1,items:[entry]}));
 const run=()=>spawnSync(process.execPath,[tool,'--state-root',state,'--profile','default',
  '--expected-active-commit',commit],{encoding:'utf8',timeout:3000});
 return {state,entry,retained,marker,m,run};
}
test('records only qualified historical candidates and never modifies registry',t=>{
 const f=fixture(t),before=fs.readFileSync(f.retained);
 const r=f.run();assert.equal(r.status,0,r.stderr);
 const j=JSON.parse(r.stdout);
 assert.equal(j.historicalCandidates,1);
 assert.equal(j.inconclusive,0);
 assert.equal(j.entries[0].action,'OWNER_REVIEW_REQUIRED_NO_AUTOMATIC_RETIREMENT');
 assert.deepEqual(fs.readFileSync(f.retained),before);
});
test('marker identity drift is inconclusive and does not mutate source',t=>{
 const f=fixture(t);
 fs.writeFileSync(f.marker,JSON.stringify({...f.m,configSha256:'d'.repeat(64)}));
 const r=f.run();assert.equal(r.status,0,r.stderr);
 assert.deepEqual(JSON.parse(r.stdout).entries[0].reasons,['RUNTIME_MARKER_IDENTITY_DRIFT']);
});
test('live retained pid is never marked historical',t=>{
 const f=fixture(t);
 const registry=JSON.parse(fs.readFileSync(f.retained));
 registry.items[0].terminalPids=[process.pid];
 fs.writeFileSync(f.retained,JSON.stringify(registry));
 const j=JSON.parse(f.run().stdout);
 assert.equal(j.inconclusive,1);
 assert.ok(j.entries[0].reasons.includes('TERMINAL_PID_ALIVE_OR_UNKNOWN'));
});
test('previous active route and outside-state configuration fail closed',t=>{
 const f=fixture(t);
 const routeFile=path.join(f.state,'routing/default.json');
 const route=JSON.parse(fs.readFileSync(routeFile));
 route.previous={commit:old};fs.writeFileSync(routeFile,JSON.stringify(route));
 assert.notEqual(f.run().status,0);
 route.previous=null;fs.writeFileSync(routeFile,JSON.stringify(route));
 const doc=JSON.parse(fs.readFileSync(f.retained));
 doc.items[0].configPath='/tmp/not-an-authorized-runtime.json';
 fs.writeFileSync(f.retained,JSON.stringify(doc));
 assert.notEqual(f.run().status,0);
});
test('symlink registry fails closed',t=>{
 const f=fixture(t);
 const target=f.retained+'.original';
 fs.renameSync(f.retained,target);
 try{fs.symlinkSync(target,f.retained);}
 catch(e){if(['EPERM','EACCES','ENOTSUP'].includes(e.code))return;throw e;}
 assert.notEqual(f.run().status,0);
});

test('optional same-owner Linux process path audit flags live reference and keeps registry unchanged',
  {skip:process.platform!=='linux'},async t=>{
 const {spawn}=await import('node:child_process');
 const f=fixture(t),before=fs.readFileSync(f.retained);
 const target=f.entry.configPath;
 const worker=spawn(process.execPath,['-e','setTimeout(()=>{},20000)','--',target],
   {stdio:'ignore'});
 t.after(()=>{try{worker.kill('SIGTERM')}catch{}});
 await new Promise((resolve,reject)=>{
   if(worker.pid&&fs.existsSync('/proc/'+worker.pid+'/cmdline'))resolve();
   else worker.once('spawn',resolve).once('error',reject);
 });
 const r=spawnSync(process.execPath,[tool,'--state-root',f.state,'--profile','default',
  '--expected-active-commit',commit,'--with-process-refs'],{encoding:'utf8',timeout:4000});
 assert.equal(r.status,0,r.stderr);
 const j=JSON.parse(r.stdout);
 assert.equal(j.processEvidence.scope,'SAME_UID_LINUX_PROC_PATHS_ONLY');
 assert.ok(j.entries[0].reasons.includes('SAME_OWNER_PROCESS_REFERENCES_HISTORIC_PATH'),r.stdout);
 assert.equal(j.inconclusive,1);
 assert.deepEqual(fs.readFileSync(f.retained),before);
});

test('optional same-owner Linux process scan preserves historical-only classification when no refs',
  {skip:process.platform!=='linux'},t=>{
 const f=fixture(t);
 const r=spawnSync(process.execPath,[tool,'--state-root',f.state,'--profile','default',
  '--expected-active-commit',commit,'--with-process-refs'],{encoding:'utf8',timeout:4000});
 assert.equal(r.status,0,r.stderr);
 const j=JSON.parse(r.stdout);
 assert.equal(j.historicalCandidates+j.inconclusive,1);
 assert.equal(j.entries[0].ownedProcessRefCount,0);
 if(j.processEvidence.unreadableOwned>0)
  assert.ok(j.entries[0].reasons.includes('OWNED_PROCESS_READ_INCOMPLETE'));
});
