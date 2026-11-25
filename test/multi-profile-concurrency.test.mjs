import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { WorkflowStore } from '../src/workflow-store.mjs';
import { MutationIdempotencyStore } from '../src/mutation-idempotency.mjs';
import { DeliveryStore, deliveryLocation } from '../src/delivery-store.mjs';
import { buildProfileInstance } from '../src/profile-instances.mjs';

function temp(prefix='rc-cross-profile-'){return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),prefix)));}
const leaseKey=root=>{const resolved=path.resolve(root);return process.platform==='win32'?resolved.toLowerCase():resolved;};
function options(root,directory,leaseDirectory,profile){
  return {
    directory,rootLeaseDirectory:leaseDirectory,allowedRoots:[root],device:'fixture',
    configSha256:'1'.repeat(64),
    authority:{profileId:profile,tier:'FULL_POWER',capabilities:['filesystem.full','workflow.durable','workflow.scheduler']},
    schedulerPolicy:{enabled:true,resumeInterrupted:true,resumeAfterRestart:true,resumeAfterUpdate:true,oneWriterPerRoot:true,maxConcurrentProjects:1,leaseMs:5000,intervalMs:1000,retryBudget:3}
  };
}
const host=dispatch=>({validate:async()=>{},dispatch});
function create(store,id,root){return store.create({id,root,goal:'cross-profile proof',acceptance:['one writer'],steps:[{id:'write',title:'Write once'}]});}

test('machine-global root lease blocks a second profile on the same project root and releases after completion',async()=>{
  const root=temp(), project=path.join(root,'project'), shared=path.join(root,'shared');
  fs.mkdirSync(project);
  const a=new WorkflowStore(options(root,path.join(root,'profile-a'),shared,'profile-a'));
  const b=new WorkflowStore(options(root,path.join(root,'profile-b'),shared,'profile-b'));
  try{
    create(a,'flowa',project);create(b,'flowb',project);
    let entered;const started=new Promise(r=>entered=r);let release;const held=new Promise(r=>release=r);
    const first=a.call({id:'flowa',stepId:'write',expectedRevision:1,tool:'write_text',arguments:{path:path.join(project,'a.txt'),content:'a'}},
      host(async()=>{entered();await held;return{ok:true};}));
    await started;
    let bEffects=0;
    await assert.rejects(
      b.call({id:'flowb',stepId:'write',expectedRevision:1,tool:'write_text',arguments:{path:path.join(project,'b.txt'),content:'b'}},
        host(async()=>{bEffects++;return{ok:true};})),
      /WORKFLOW_ROOT_LEASED/
    );
    assert.equal(bEffects,0);
    assert.equal(b.get('flowb').state.revision,1);
    assert.equal(a.schedulerStatus().currentLeases,1);
    assert.equal(b.schedulerStatus().currentLeases,1);
    release();const firstResult=await first;
    assert.equal(firstResult.receipt.fencingToken,1);
    assert.equal(a.schedulerStatus().currentLeases,0);
    const second=await b.call({id:'flowb',stepId:'write',expectedRevision:1,tool:'write_text',arguments:{path:path.join(project,'b.txt'),content:'b'}},
      host(async()=>{bEffects++;return{ok:true};}));
    assert.equal(second.outcome,'RECORDED_NOT_VALIDATED');
    assert.equal(second.receipt.fencingToken,2);
    assert.equal(bEffects,1);
  }finally{a.close();b.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('separate OS processes share one root lease and preserve monotonic fencing across release',async()=>{
  const root=temp(),project=path.join(root,'project'),shared=path.join(root,'shared');
  fs.mkdirSync(project);
  const a=new WorkflowStore(options(root,path.join(root,'profile-parent'),shared,'profile-parent'));
  const marker=path.join(project,'child-effect.txt');
  const childSource=[
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const [moduleUrl,config64,project,marker]=process.argv.slice(1);",
    "const { WorkflowStore }=await import(moduleUrl);",
    "const config=JSON.parse(Buffer.from(config64,'base64').toString('utf8'));",
    "const store=new WorkflowStore(config);",
    "try {",
    "  store.create({id:'child',root:project,goal:'separate process lease proof',acceptance:['one effect'],steps:[{id:'write',title:'Write once'}]});",
    "  const result=await store.call({id:'child',stepId:'write',expectedRevision:1,tool:'write_text',arguments:{path:marker,content:'applied'}},",
    "    {validate:async()=>{},dispatch:async()=>{fs.writeFileSync(marker,'applied');return{ok:true};}});",
    "  process.stdout.write(JSON.stringify({outcome:result.outcome,fencingToken:result.receipt.fencingToken}));",
    "} catch(error) {",
    "  if(error?.workflowCode==='WORKFLOW_ROOT_LEASED')process.stdout.write('LEASED');",
    "  else {process.stderr.write(String(error?.stack||error));process.exitCode=1;}",
    "} finally {store.close();}"
  ].join('\n');
  const runChild=profile=>{
    const config=options(root,path.join(root,'profile-'+profile),shared,'profile-'+profile);
    return spawnSync(process.execPath,
      ['--input-type=module','-e',childSource,new URL('../src/workflow-store.mjs',import.meta.url).href,
        Buffer.from(JSON.stringify(config)).toString('base64'),project,marker],
      {encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
  };
  let release,started;
  const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>started=resolve);
  let first;
  try{
    create(a,'parent',project);
    first=a.call({id:'parent',stepId:'write',expectedRevision:1,tool:'write_text',arguments:{path:path.join(project,'parent.txt'),content:'parent'}},
      host(async()=>{started();await gate;return{ok:true};}));
    await entered;
    const blocked=runChild('blocked');
    assert.equal(blocked.error,undefined,String(blocked.error));
    assert.equal(blocked.status,0,blocked.stderr);
    assert.equal(blocked.stdout,'LEASED');
    assert.equal(fs.existsSync(marker),false);
    release();
    const parentResult=await first;
    assert.equal(parentResult.receipt.fencingToken,1);
    const accepted=runChild('accepted');
    assert.equal(accepted.error,undefined,String(accepted.error));
    assert.equal(accepted.status,0,accepted.stderr);
    assert.deepEqual(JSON.parse(accepted.stdout),{outcome:'RECORDED_NOT_VALIDATED',fencingToken:2});
    assert.equal(fs.readFileSync(marker,'utf8'),'applied');
    const db=new DatabaseSync(path.join(shared,'root-leases.sqlite'));
    try{
      assert.equal(db.prepare('SELECT last_token FROM root_lease_counters WHERE root=?').get(leaseKey(project)).last_token,2);
      assert.equal(db.prepare('SELECT count(*) AS n FROM root_leases').get().n,0);
    }finally{db.close();}
  }finally{
    release();
    if(first)await first.catch(()=>{});
    a.close();
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('expired root-lease holder blocks all new effects until independent cessation reconciliation',async()=>{
  const root=temp(),project=path.join(root,'project'),shared=path.join(root,'shared');
  fs.mkdirSync(project);
  const a=new WorkflowStore(options(root,path.join(root,'profile-a'),shared,'profile-a'));
  const b=new WorkflowStore(options(root,path.join(root,'profile-b'),shared,'profile-b'));
  const leaseDb=new DatabaseSync(path.join(shared,'root-leases.sqlite'));
  let releaseA,first;
  try {
    create(a,'flowa',project);create(b,'flowb',project);
    let enteredA;const startedA=new Promise(r=>enteredA=r);
    const heldA=new Promise(r=>releaseA=r);
    first=a.call({id:'flowa',stepId:'write',expectedRevision:1,tool:'write_text',arguments:{path:path.join(project,'a.txt'),content:'a'}},
      host(async()=>{enteredA();await heldA;return{ok:true};}));
    await startedA;
    const key=leaseKey(project);
    assert.equal(leaseDb.prepare('SELECT fencing_token FROM root_leases WHERE root=?').get(key).fencing_token,1);
    leaseDb.prepare('UPDATE root_leases SET expires_at=? WHERE root=?').run('2000-01-01T00:00:00.000Z',key);
    let effectsB=0;
    await assert.rejects(b.call({id:'flowb',stepId:'write',expectedRevision:1,tool:'write_text',arguments:{path:path.join(project,'b.txt'),content:'b'}},
      host(async()=>{effectsB++;return{ok:true};})),/WORKFLOW_ROOT_LEASE_EXPIRED_RECONCILIATION_REQUIRED/);
    assert.equal(effectsB,0);
    assert.equal(leaseDb.prepare('SELECT fencing_token FROM root_leases WHERE root=?').get(key).fencing_token,1);
    releaseA();
    const stale=await first;
    assert.equal(stale.outcome,'UNCERTAIN');
    assert.equal(stale.receipt.errorCode,'WORKFLOW_ROOT_LEASE_LOST');
    assert.equal(a.get('flowa').state.steps[0].status,'uncertain');
    assert.equal(leaseDb.prepare('SELECT fencing_token FROM root_leases WHERE root=?').get(key).fencing_token,1);
  }finally{
    releaseA?.();if(first)await first.catch(()=>{});
    leaseDb.close();a.close();b.close();fs.rmSync(root,{recursive:true,force:true});
  }
});

test('expired root lease before dispatch blocks the external effect',async()=>{
  const root=temp(),project=path.join(root,'project'),shared=path.join(root,'shared');
  fs.mkdirSync(project);
  const store=new WorkflowStore(options(root,path.join(root,'profile-a'),shared,'profile-a'));
  const leaseDb=new DatabaseSync(path.join(shared,'root-leases.sqlite'));
  let effects=0;
  try{
    create(store,'flowpre',project);
    leaseDb.exec(`CREATE TRIGGER expire_new_root_lease AFTER INSERT ON root_leases
      BEGIN UPDATE root_leases SET expires_at='2000-01-01T00:00:00.000Z' WHERE root=NEW.root; END;`);
    const result=await store.call(
      {id:'flowpre',stepId:'write',expectedRevision:1,tool:'write_text',arguments:{path:path.join(project,'never.txt'),content:'never'}},
      host(async()=>{effects++;return{ok:true};})
    );
    assert.equal(result.outcome,'UNCERTAIN');
    assert.equal(result.receipt.errorCode,'WORKFLOW_ROOT_LEASE_LOST');
    assert.equal(result.receipt.notDispatched,true);
    assert.equal(result.operation.status,'UNCERTAIN');
    assert.equal(store.get('flowpre').state.steps[0].status,'uncertain');
    assert.equal(effects,0);
    assert.equal(store.schedulerStatus().currentLeases,0);
  }finally{
    leaseDb.close();store.close();fs.rmSync(root,{recursive:true,force:true});
  }
});

test('root fencing counters reject token rollback and deletion across profiles',async()=>{
  const root=temp(),project=path.join(root,'project'),shared=path.join(root,'shared');
  fs.mkdirSync(project);
  const a=new WorkflowStore(options(root,path.join(root,'profile-a'),shared,'profile-a'));
  const b=new WorkflowStore(options(root,path.join(root,'profile-b'),shared,'profile-b'));
  const leaseDb=new DatabaseSync(path.join(shared,'root-leases.sqlite'));
  const key=leaseKey(project);
  let effects=0;
  try{
    create(a,'flowa',project);create(b,'flowb',project);
    const first=await a.call({id:'flowa',stepId:'write',expectedRevision:1,tool:'write_text',arguments:{path:path.join(project,'a.txt'),content:'a'}},
      host(async()=>{effects++;return{ok:true};}));
    assert.equal(first.receipt.fencingToken,1);
    assert.equal(leaseDb.prepare('SELECT last_token FROM root_lease_counters WHERE root=?').get(key).last_token,1);
    assert.throws(()=>leaseDb.prepare('UPDATE root_lease_counters SET last_token=0 WHERE root=?').run(key),/ROOT_FENCE_TOKEN_REUSE/);
    assert.throws(()=>leaseDb.prepare('UPDATE root_lease_counters SET last_token=1 WHERE root=?').run(key),/ROOT_FENCE_TOKEN_REUSE/);
    assert.throws(()=>leaseDb.prepare('DELETE FROM root_lease_counters WHERE root=?').run(key),/ROOT_FENCE_COUNTER_DELETE/);
    const second=await b.call({id:'flowb',stepId:'write',expectedRevision:1,tool:'write_text',arguments:{path:path.join(project,'b.txt'),content:'b'}},
      host(async()=>{effects++;return{ok:true};}));
    assert.equal(second.receipt.fencingToken,2);
    assert.equal(leaseDb.prepare('SELECT last_token FROM root_lease_counters WHERE root=?').get(key).last_token,2);
    assert.equal(effects,2);
  }finally{
    leaseDb.close();a.close();b.close();fs.rmSync(root,{recursive:true,force:true});
  }
});

test('legacy root-lease schema migrates without discarding an active owner',async()=>{
  const root=temp(),project=path.join(root,'project'),shared=path.join(root,'shared');
  fs.mkdirSync(project);fs.mkdirSync(shared);
  const legacyDb=new DatabaseSync(path.join(shared,'root-leases.sqlite'));
  legacyDb.exec(`CREATE TABLE root_leases(
    root TEXT PRIMARY KEY,profile TEXT NOT NULL,workflow TEXT NOT NULL,
    owner TEXT NOT NULL,expires_at TEXT NOT NULL,revision INTEGER NOT NULL
  );`);
  legacyDb.prepare('INSERT INTO root_leases(root,profile,workflow,owner,expires_at,revision) VALUES(?,?,?,?,?,?)')
    .run(path.resolve(project),'legacy-profile','legacy-flow','legacy-owner',new Date(Date.now()+300000).toISOString(),1);
  legacyDb.close();
  const store=new WorkflowStore(options(root,path.join(root,'profile-new'),shared,'profile-new'));
  try{
    create(store,'flownew',project);
    const migrated=new DatabaseSync(path.join(shared,'root-leases.sqlite'));
    try{
      const columns=migrated.prepare('PRAGMA table_info(root_leases)').all().map(column=>column.name);
      assert.ok(columns.includes('fencing_token'));
      assert.equal(migrated.prepare('SELECT fencing_token FROM root_leases WHERE root=?').get(leaseKey(project)).fencing_token,0);
      assert.equal(migrated.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='root_lease_counters'").get().name,'root_lease_counters');
    }finally{migrated.close();}
    await assert.rejects(
      store.call({id:'flownew',stepId:'write',expectedRevision:1,tool:'write_text',arguments:{path:path.join(project,'new.txt'),content:'new'}},
        host(async()=>({ok:true}))),
      /WORKFLOW_ROOT_LEASED/
    );
  }finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('machine-global root lease permits independent roots to execute concurrently',async()=>{
  const root=temp(), p1=path.join(root,'p1'),p2=path.join(root,'p2'),shared=path.join(root,'shared');
  fs.mkdirSync(p1);fs.mkdirSync(p2);
  const a=new WorkflowStore(options(root,path.join(root,'a'),shared,'profile-a'));
  const b=new WorkflowStore(options(root,path.join(root,'b'),shared,'profile-b'));
  try{
    create(a,'flowa',p1);create(b,'flowb',p2);
    let releaseA;const heldA=new Promise(r=>releaseA=r);let enteredA;const startA=new Promise(r=>enteredA=r);
    const first=a.call({id:'flowa',stepId:'write',expectedRevision:1,tool:'write_text',arguments:{path:path.join(p1,'a.txt'),content:'a'}},
      host(async()=>{enteredA();await heldA;return{ok:true};}));
    await startA;
    const second=await b.call({id:'flowb',stepId:'write',expectedRevision:1,tool:'write_text',arguments:{path:path.join(p2,'b.txt'),content:'b'}},
      host(async()=>({ok:true})));
    assert.equal(second.outcome,'RECORDED_NOT_VALIDATED');
    releaseA();await first;
  }finally{a.close();b.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('concurrent same mutation requestId produces one effect and later retry reuses durable success',async()=>{
  const root=temp();let effects=0;const store=new MutationIdempotencyStore({directory:path.join(root,'mut'),scope:'profile-a'});
  try{
    let release;const held=new Promise(r=>release=r);let entered;const started=new Promise(r=>entered=r);
    const input={id:'term',input:'x'};
    const first=store.execute({requestId:'same-req',tool:'send_terminal',input},async()=>{effects++;entered();await held;return{ok:true,effects};});
    await started;
    await assert.rejects(
      store.execute({requestId:'same-req',tool:'send_terminal',input},async()=>{effects++;return{ok:true,effects};}),
      /MUTATION_OUTCOME_UNCERTAIN/
    );
    assert.equal(effects,1);
    release();const result=await first;
    assert.deepEqual(result,{ok:true,effects:1});
    const retry=await store.execute({requestId:'same-req',tool:'send_terminal',input},async()=>{effects++;return{ok:true,effects};});
    assert.deepEqual(retry,result);assert.equal(effects,1);
  }finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('profile delivery scopes do not leak event metadata or claim authority',()=>{
  const root=temp(),dir=path.join(root,'delivery');
  const a=new DeliveryStore({directory:dir,scope:'profile-a'});
  const b=new DeliveryStore({directory:dir,scope:'profile-b'});
  try{
    const item=a.publish({eventKey:'same-project:done',correlationId:'chat-a',source:'project',sourceId:'run-a',kind:'COMPLETED'});
    assert.throws(()=>b.get(item.deliveryId,'chat-a'),/DELIVERY_NOT_FOUND|DELIVERY_CORRELATION_MISMATCH/);
    assert.throws(()=>b.claim({deliveryId:item.deliveryId,correlationId:'chat-a',attemptId:'b-attempt'}),/DELIVERY_NOT_FOUND|DELIVERY_CORRELATION_MISMATCH/);
    assert.equal(b.list({correlationId:'chat-a'}).items.length,0);
  }finally{a.close();b.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('profile builder derives the same machine-global lease directory for isolated profiles',()=>{
  const root=temp(),machine=path.join(root,'machine'),instances=path.join(machine,'instances');
  const project=path.join(root,'project');fs.mkdirSync(project,{recursive:true});
  const base={
    allowedRoots:[project],allowedPrograms:['node'],
    powerMode:{enabled:true,fullFilesystem:true,allowShell:true,allowProcessControl:true,allowPermanentDelete:true,
      guiControl:{enabled:false,allowScreenshot:true,allowMouse:true,allowKeyboard:true,allowWindowFocus:true}},
    durableWorkflows:{enabled:true,scheduler:{enabled:true,oneWriterPerRoot:true,maxConcurrentProjects:1}}
  };
  try{
    const a=buildProfileInstance({baseConfig:base,profile:'a',port:48001,stateDirectory:path.join(instances,'a'),allowedRoots:[project],powerMode:true});
    const b=buildProfileInstance({baseConfig:base,profile:'b',port:48002,stateDirectory:path.join(instances,'b'),allowedRoots:[project],powerMode:true});
    const expected=path.join(machine,'shared','root-leases');
    assert.equal(a.config.durableWorkflows.rootLeaseDirectory,expected);
    assert.equal(b.config.durableWorkflows.rootLeaseDirectory,expected);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('candidate delivery identity is stable across routed config-path rotation',()=>{
  const root=temp('rc-delivery-candidate-'),state=path.join(root,'state'),workflow=path.join(root,'workflow');
  const project=path.join(root,'project');fs.mkdirSync(project,{recursive:true});fs.mkdirSync(state,{recursive:true});fs.mkdirSync(workflow,{recursive:true});
  const defaults={
    deviceName:'linux-fixture',host:'127.0.0.1',port:47831,allowedRoots:[project],allowedPrograms:['node'],
    powerMode:{enabled:false,fullFilesystem:false,allowShell:false,allowProcessControl:false,allowPermanentDelete:false,guiControl:{enabled:false}},
    durableWorkflows:{enabled:true,directory:workflow,scheduler:{enabled:true,oneWriterPerRoot:true,maxConcurrentProjects:1}}
  };
  const defaultPath=path.join(root,'default.json'),existingPath=path.join(root,'existing-v1.json');
  fs.writeFileSync(defaultPath,JSON.stringify(defaults));
  const existing={...defaults,instance:{profile:'default',isolated:false},capabilityProfile:{id:'default',schemaVersion:1,tier:'STANDARD',capabilities:[],disabledCapabilities:[]}};
  fs.writeFileSync(existingPath,JSON.stringify(existing));
  try{
    const legacy=deliveryLocation(existing,existingPath);
    const out1=path.join(root,'runtime-a','config.json'),out2=path.join(root,'runtime-b','config.json');
    fs.mkdirSync(path.dirname(out1),{recursive:true});fs.mkdirSync(path.dirname(out2),{recursive:true});
    let run=spawnSync(process.execPath,['tools/build-candidate-config.mjs','--default',defaultPath,'--existing',existingPath,'--output',out1,'--profile-id','default','--port','48010','--state-dir',path.join(root,'runtime-a'),'--workflow-dir',workflow],{cwd:path.resolve('.'),encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);
    const first=JSON.parse(fs.readFileSync(out1,'utf8'));
    assert.equal(first.durableDelivery.scope,legacy.scope);
    assert.equal(first.durableDelivery.directory,legacy.directory);
    run=spawnSync(process.execPath,['tools/build-candidate-config.mjs','--default',defaultPath,'--existing',out1,'--output',out2,'--profile-id','default','--port','48011','--state-dir',path.join(root,'runtime-b'),'--workflow-dir',workflow],{cwd:path.resolve('.'),encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);
    const second=JSON.parse(fs.readFileSync(out2,'utf8'));
    assert.equal(second.durableDelivery.scope,first.durableDelivery.scope);
    assert.equal(second.durableDelivery.directory,first.durableDelivery.directory);
    assert.notEqual(path.resolve(out1),path.resolve(out2));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('candidate config pins shared lease directory under the supplied machine state root',()=>{
  const root=temp(),state=path.join(root,'state'),runtime=path.join(root,'runtime'),workflow=path.join(root,'workflow'),out=path.join(root,'candidate.json');
  fs.mkdirSync(state,{recursive:true});fs.mkdirSync(runtime,{recursive:true});fs.mkdirSync(workflow,{recursive:true});
  const project=path.join(root,'project');fs.mkdirSync(project);
  const defaults={
    host:'127.0.0.1',port:47831,allowedRoots:[project],allowedPrograms:['node'],
    powerMode:{enabled:false,fullFilesystem:false,allowShell:false,allowProcessControl:false,allowPermanentDelete:false,guiControl:{enabled:false}},
    durableWorkflows:{enabled:true,directory:workflow,scheduler:{enabled:true,oneWriterPerRoot:true,maxConcurrentProjects:1}}
  };
  const defaultPath=path.join(root,'default.json');fs.writeFileSync(defaultPath,JSON.stringify(defaults));
  try{
    const run=spawnSync(process.execPath,['tools/build-candidate-config.mjs','--default',defaultPath,'--output',out,'--profile-id','default','--port','48010','--state-dir',runtime,'--workflow-dir',workflow,'--provider-root',state],{cwd:path.resolve('.'),encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);
    const cfg=JSON.parse(fs.readFileSync(out,'utf8'));
    assert.equal(cfg.durableWorkflows.rootLeaseDirectory,path.join(state,'shared','root-leases'));
    assert.match(cfg.durableDelivery.scope,/^[a-f0-9]{64}$/);
    assert.equal(cfg.durableDelivery.directory,path.join(os.homedir(),'.chatgpt-remote-commander','delivery','profiles',cfg.durableDelivery.scope));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
