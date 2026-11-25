import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { WorkflowStore } from '../src/workflow-store.mjs';
import { authorityCompatible, normalizeAuthority } from '../src/workflow-autonomy.mjs';
import { createWorkflowTools } from '../src/workflow-tools.mjs';
import { migrateCapabilityConfig, deriveCapabilitySet } from '../src/capability-profile.mjs';

const worker=fileURLToPath(new URL('./workflow-worker.mjs',import.meta.url));
const migrator=fileURLToPath(new URL('../tools/capability-migrate.mjs',import.meta.url));
const finalizer=fileURLToPath(new URL('../tools/finalize-workflow-schema.mjs',import.meta.url));

function temp(prefix='rc-autonomy-'){
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),prefix)));
}
function options(root, extra={}){
  return {
    directory:path.join(root,'memory'),allowedRoots:[root],device:'fixture',
    configSha256:'1'.repeat(64),
    authority:{profileId:'default',tier:'FULL_POWER',capabilities:['filesystem.full','workflow.durable','workflow.scheduler']},
    executionProfile:{modelFamily:'GPT-5.6',modelVariant:'Sol',reasoningEffort:'High',executionMode:'project-agent',profileVersion:'1',fallbackPolicy:'equivalent-or-better'},
    schedulerPolicy:{enabled:true,resumeInterrupted:true,resumeAfterRestart:true,resumeAfterUpdate:true,oneWriterPerRoot:true,maxConcurrentProjects:1,leaseMs:5000,intervalMs:1000,retryBudget:3},
    ...extra
  };
}
function create(store,root,id='sample',steps=[{id:'first',title:'First'}]){
  return store.create({id,root,goal:'Reach evidence-backed final',acceptance:['proof verified'],steps});
}
function child(mode,root){
  return new Promise((resolve,reject)=>{
    const p=spawn(process.execPath,[worker,mode,root],{stdio:['ignore','pipe','pipe']});
    let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);
    const timer=setTimeout(()=>{p.kill();reject(new Error('worker timeout'));},15000);
    p.once('error',reject);p.once('close',code=>{clearTimeout(timer);resolve({code,out,err});});
  });
}
const host=dispatch=>({validate:async()=>{},dispatch});

test('A process crash is recovered as uncertain and never duplicated',async()=>{
  const root=temp();try{
    let s=new WorkflowStore(options(root));create(s,root);
    s.close();
    const r=await child('crash',root);assert.equal(r.code,73,r.err);
    s=new WorkflowStore(options(root));
    try{
      const state=s.get('sample').state;
      assert.equal(state.steps[0].status,'uncertain');
      assert.equal(state.lifecycleState,'INTERRUPTED');
      assert.equal(fs.readFileSync(path.join(root,'effect.txt'),'utf8'),'once');
      await assert.rejects(
        s.call({id:'sample',stepId:'first',expectedRevision:state.revision,tool:'read_text',arguments:{path:'x'}},host(async()=>({ok:true}))),
        /REQUIRES_RECONCILIATION/
      );
      assert.equal(fs.readFileSync(path.join(root,'effect.txt'),'utf8'),'once');
      assert.equal(s.operations('sample')[0].status,'UNCERTAIN');
    }finally{s.close();}
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('B restart preserves durable queue and resumable checkpoint',()=>{
  const root=temp();try{
    let s=new WorkflowStore(options(root));create(s,root);
    fs.writeFileSync(path.join(root,'proof.txt'),'stable');
    s.checkpoint({id:'sample',expectedRevision:1,files:['proof.txt'],nextAction:'Run exact next step',summary:'checkpoint'});
    const queued=s.list().find(x=>x.id==='sample');assert.equal(queued.lifecycle,'WAITING');assert.equal(queued.schedulerEnabled,true);
    const before=s.schedulerStatus();assert.equal(before.pending,1);assert.equal(before.runnerConfigured,false);assert.equal(before.automaticExecution,false);assert.equal(before.automaticContinuationScope,'RECOVERY_AND_READINESS_ONLY');s.close();
    s=new WorkflowStore(options(root));
    try{
      const after=s.schedulerStatus(),r=s.resume('sample');
      assert.equal(after.pending,1);assert.equal(r.readyForNextStep,true);
      assert.equal(r.nextAction,'Run exact next step');
      assert.equal(r.automaticContinuation,true);
    }finally{s.close();}
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('C commander update config hash drift resumes when authority is preserved and blocks authority regression',()=>{
  const root=temp();try{
    let s=new WorkflowStore(options(root));create(s,root);s.close();
    s=new WorkflowStore(options(root,{configSha256:'2'.repeat(64)}));
    try{const r=s.resume('sample');assert.equal(r.configDrift,true);assert.deepEqual(r.blockers,[]);}finally{s.close();}
    s=new WorkflowStore(options(root,{configSha256:'3'.repeat(64),authority:{profileId:'default',tier:'STANDARD',capabilities:['workflow.durable']}}));
    try{assert.ok(s.resume('sample').blockers.includes('WORKFLOW_AUTHORITY_REGRESSION'));}finally{s.close();}
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('owner tier changes fail closed even when effective capability names stay identical',()=>{
  for(const [originalTier,currentTier] of [['FULL_POWER','STANDARD'],['STANDARD','FULL_POWER']]){
    const root=temp();
    try{
      const capabilities=['workflow.durable','workflow.scheduler'];
      let s=new WorkflowStore(options(root,{
        authority:{profileId:'default',tier:originalTier,capabilities}
      }));
      create(s,root);s.close();
      s=new WorkflowStore(options(root,{
        configSha256:'4'.repeat(64),
        authority:{profileId:'default',tier:currentTier,capabilities:[...capabilities]}
      }));
      try{
        const resumed=s.resume('sample');
        assert.equal(resumed.readyForNextStep,false);
        assert.ok(resumed.blockers.includes('WORKFLOW_AUTHORITY_TIER_CHANGED'),
          originalTier+' -> '+currentTier+' must require fresh owner authorization');
        assert.equal(s.get('sample').state.steps[0].status,'pending');
      }finally{s.close();}
    }finally{fs.rmSync(root,{recursive:true,force:true});}
  }
});

test('unknown FULL_ACCESS owner tier is never silently coerced to STANDARD during workflow admission',()=>{
  const capabilities=['workflow.durable'];
  const valid={profileId:'default',tier:'STANDARD',capabilities};
  const unsupported={...valid,tier:'FULL_ACCESS'};
  assert.throws(()=>normalizeAuthority(unsupported),/WORKFLOW_AUTHORITY_TIER_UNSUPPORTED/);
  assert.deepEqual(authorityCompatible(unsupported,valid),{
    ok:false,code:'WORKFLOW_AUTHORITY_TIER_UNSUPPORTED',missing:[]
  });
  assert.deepEqual(authorityCompatible(valid,unsupported),{
    ok:false,code:'WORKFLOW_AUTHORITY_TIER_UNSUPPORTED',missing:[]
  });
  assert.equal(normalizeAuthority({profileId:'default',capabilities}).tier,'STANDARD',
    'legacy omitted tier retains explicit STANDARD fallback');
  const root=temp();
  try{
    assert.throws(()=>new WorkflowStore(options(root,{authority:unsupported})),
      /WORKFLOW_AUTHORITY_TIER_UNSUPPORTED/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('D lost receipt after file mutation reconciles APPLIED by read-only hash and never reruns',async()=>{
  const root=temp();try{
    let s=new WorkflowStore(options(root));create(s,root);s.close();
    const r=await child('crash-write',root);assert.equal(r.code,75,r.err);
    s=new WorkflowStore(options(root));
    let verifies=0;
    try{
      const a=await s.reconcileAutomatically('sample',{verify:async plan=>{
        verifies++;assert.equal(plan.strategy,'FILE_SHA256');
        const actual=createHash('sha256').update(fs.readFileSync(path.join(root,'proof.txt'))).digest('hex');
        return actual===plan.expectedSha256?{status:'APPLIED',evidenceHash:actual,summary:'hash matched'}:{status:'CONFLICT',evidenceHash:actual,summary:'mismatch'};
      }});
      assert.equal(a.status,'APPLIED');assert.equal(s.get('sample').state.steps[0].status,'reconciled_applied');
      const b=await s.reconcileAutomatically('sample',{verify:async()=>{verifies++;return{status:'APPLIED'};}});
      assert.equal(b.changed,false);assert.equal(verifies,1);
      assert.equal(fs.readFileSync(path.join(root,'proof.txt'),'utf8'),'expected');
    }finally{s.close();}
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('E mutation absent after failed dispatch reconciles NOT_APPLIED without blind retry',async()=>{
  const root=temp();try{
    const s=new WorkflowStore(options(root));try{
      create(s,root);
      const call=await s.call({id:'sample',stepId:'first',expectedRevision:1,tool:'write_text',arguments:{path:'proof.txt',mode:'overwrite',content:'expected'}},
        host(async()=>{throw Object.assign(new Error('not executed'),{workflowCode:'FIXTURE_FAIL'});}));
      assert.equal(call.outcome,'UNCERTAIN');assert.equal(fs.existsSync(path.join(root,'proof.txt')),false);
      const a=await s.reconcileAutomatically('sample',{verify:async()=>({status:'NOT_APPLIED',summary:'target absent'})});
      assert.equal(a.status,'NOT_APPLIED');assert.equal(s.get('sample').state.steps[0].status,'reconciled_not_applied');
      assert.equal(s.operations('sample')[0].status,'NOT_APPLIED');
    }finally{s.close();}
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('F unexpected post-state becomes CONFLICT and repeated reconciliation does not loop',async()=>{
  const root=temp();try{
    const s=new WorkflowStore(options(root));let verifies=0;try{
      create(s,root);
      await s.call({id:'sample',stepId:'first',expectedRevision:1,tool:'write_text',arguments:{path:'proof.txt',mode:'overwrite',content:'expected'}},
        host(async()=>{fs.writeFileSync(path.join(root,'proof.txt'),'unexpected');throw Object.assign(new Error('lost'),{workflowCode:'FIXTURE_FAIL'});}));
      const a=await s.reconcileAutomatically('sample',{verify:async plan=>{
        verifies++;const actual=createHash('sha256').update(fs.readFileSync(path.join(root,'proof.txt'))).digest('hex');
        return {status:actual===plan.expectedSha256?'APPLIED':'CONFLICT',evidenceHash:actual,summary:'compare'};
      }});
      assert.equal(a.status,'CONFLICT');assert.equal(s.operations('sample')[0].status,'CONFLICT');
      const b=await s.reconcileAutomatically('sample',{verify:async()=>{verifies++;return{status:'APPLIED'};}});
      assert.equal(b.changed,false);assert.equal(verifies,1);
    }finally{s.close();}
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('G execution profile survives restart and scheduler exposes explicit unavailable-model stop',async()=>{
  const root=temp();let tool;try{
    const config={
      durableWorkflows:{enabled:true,directory:path.join(root,'memory'),executionTools:['read_text'],
        scheduler:{enabled:true,intervalMs:60000,retryBudget:3},
        executionProfile:{default:{modelFamily:'GPT-5.6',modelVariant:'Sol',reasoningEffort:'High',fallbackPolicy:'equivalent-or-better'}}},
      powerMode:{enabled:true,fullFilesystem:true,allowShell:true,allowProcessControl:true,allowPermanentDelete:true,guiControl:{enabled:false}},
      capabilityProfile:{id:'default',tier:'FULL_POWER',explicitlyAuthorized:true,persistAcrossUpdates:true}
    };
    tool=createWorkflowTools({config,roots:[root],device:'fixture',configSha256:'1'.repeat(64),
      lookup:name=>({name,inputSchema:{type:'object'}}),validateSchema:()=>[],dispatch:async()=>({ok:true})});
    await tool.execute('workflow_create',{id:'model',root,goal:'continue',acceptance:['done'],steps:[{id:'one',title:'Reason next'}],
      executionProfile:{modelFamily:'GPT-5.6',modelVariant:'Sol',reasoningEffort:'High',executionMode:'project-agent',profileVersion:'1',fallbackPolicy:'equivalent-or-better'}});
    const tick=await tool.execute('workflow_scheduler_tick',{});
    const item=tick.ready.find(x=>x.id==='model');assert.ok(item);assert.equal(item.stopCondition,'MODEL_PROFILE_UNAVAILABLE');
    assert.equal(item.executionProfile.modelVariant,'Sol');assert.equal(tick.runnerConfigured,false);assert.equal(tick.automaticExecution,false);assert.equal(tick.automaticContinuationScope,'RECOVERY_AND_READINESS_ONLY');
  }finally{tool?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('H finalization is evidence-backed, preserves existing Brain text, and only then COMPLETED',async()=>{
  const root=temp();try{
    const s=new WorkflowStore(options(root));try{
      fs.writeFileSync(path.join(root,'PROJECT_BRAIN.md'),'# Existing History\n\nKEEP_ME\n');
      fs.writeFileSync(path.join(root,'proof.txt'),'proof');
      create(s,root);
      await s.call({id:'sample',stepId:'first',expectedRevision:1,tool:'read_text',arguments:{path:'proof.txt'}},host(async()=>({ok:true,text:'proof'})));
      assert.throws(()=>s.finalize({id:'sample',expectedRevision:3,acceptanceResults:[false],files:['proof.txt'],summary:'not proven'}),/ACCEPTANCE_UNPROVEN/);
      assert.notEqual(s.get('sample').state.lifecycleState,'COMPLETED');
      const done=s.finalize({id:'sample',expectedRevision:3,acceptanceResults:[true],files:['proof.txt'],summary:'verified'});
      assert.equal(done.state.lifecycleState,'COMPLETED');assert.equal(done.acceptanceStatus,'PASS');
      const md=fs.readFileSync(path.join(root,'PROJECT_BRAIN.md'),'utf8');
      assert.match(md,/KEEP_ME/);assert.match(md,/RC_WORKFLOW_STATE:sample:BEGIN/);
      assert.ok(fs.existsSync(path.join(root,'project-brain.sample.json')));
      assert.equal(s.schedulerStatus().pending,0);
    }finally{s.close();}
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('I upgrade migration preserves explicit FULL_POWER including permanent delete and backs up workflow DB',()=>{
  const root=temp();try{
    const workflowDir=path.join(root,'workflows');fs.mkdirSync(workflowDir);
    const db=new DatabaseSync(path.join(workflowDir,'workflows.sqlite'));db.exec('CREATE TABLE t(x); INSERT INTO t VALUES(1);');db.close();
    const defaults={allowedRoots:[root],allowedPrograms:['git'],powerMode:{enabled:false,fullFilesystem:false,allowShell:false,allowProcessControl:false,allowPermanentDelete:false,guiControl:{enabled:false,allowScreenshot:true,allowMouse:true,allowKeyboard:true,allowWindowFocus:true}}};
    const existing={...defaults,powerMode:{enabled:true,fullFilesystem:true,allowShell:true,allowProcessControl:true,allowPermanentDelete:true,blockedShellPatterns:[],guiControl:{enabled:true,allowScreenshot:true,allowMouse:true,allowKeyboard:true,allowWindowFocus:true}},
      durableWorkflows:{enabled:true,directory:workflowDir,executionTools:['read_text']},
      capabilityProfile:{schemaVersion:1,id:'default',tier:'FULL_POWER',explicitlyAuthorized:true,persistAcrossUpdates:true}};
    const d=path.join(root,'default.json'),e=path.join(root,'existing.json'),o=path.join(root,'out.json'),b=path.join(root,'backups');
    fs.writeFileSync(d,JSON.stringify(defaults));fs.writeFileSync(e,JSON.stringify(existing));
    const r=spawnSync(process.execPath,[migrator,'--default',d,'--existing',e,'--output',o,'--profile-id','default','--backup-root',b,'--workflow-dir',workflowDir],{encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);const result=JSON.parse(r.stdout.trim()),actual=JSON.parse(fs.readFileSync(o,'utf8'));
    assert.equal(result.status,'CAPABILITY_MIGRATION_PASS');assert.equal(actual.powerMode.allowPermanentDelete,true);
    assert.equal(actual.powerMode.allowShell,true);assert.equal(actual.powerMode.allowProcessControl,true);assert.equal(actual.powerMode.guiControl.enabled,true);
    assert.equal(actual.durableWorkflows.scheduler.enabled,true);assert.equal(actual.durableWorkflows.continuation.enabled,true);
    assert.ok(fs.existsSync(path.join(result.backupDir,'config.before.json')));
    assert.ok(fs.existsSync(path.join(result.backupDir,'workflows.sqlite')));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('J newly authorized FULL_POWER receives all known capabilities unless explicitly disabled',()=>{
  const root=temp();try{
    const defaults={allowedRoots:[root],allowedPrograms:['git'],powerMode:{enabled:false,fullFilesystem:false,allowShell:false,allowProcessControl:false,allowPermanentDelete:false,guiControl:{enabled:false,allowScreenshot:true,allowMouse:true,allowKeyboard:true,allowWindowFocus:true}}};
    const r=migrateCapabilityConfig({defaultConfig:defaults,existingConfig:null,profileId:'default',requestPower:true,requestGui:true,workflowDirectory:path.join(root,'wf')});
    const caps=deriveCapabilitySet(r.config);
    for(const c of ['filesystem.full','shell.execute','process.control','workflow.durable','workflow.scheduler','workflow.autonomous_resume','workflow.reconcile','workflow.checkpoint','workflow.project_brain','workflow.execution_profile_persistence','workflow.crash_recovery','workflow.durable_queue']) assert.ok(caps.includes(c),c);
    assert.equal(r.config.powerMode.allowPermanentDelete,true);
    assert.equal(r.profile.explicitlyAuthorized,true);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('one writer lease blocks a second workflow on the same project root',async()=>{
  const root=temp();try{
    const s=new WorkflowStore(options(root));try{
      create(s,root,'a');create(s,root,'b');
      let release;const wait=new Promise(r=>release=r);
      const first=s.call({id:'a',stepId:'first',expectedRevision:1,tool:'write_text',arguments:{path:'a.txt',content:'a'}},
        host(async()=>{await wait;return{ok:true};}));
      await new Promise(r=>setTimeout(r,50));
      await assert.rejects(
        s.call({id:'b',stepId:'first',expectedRevision:1,tool:'write_text',arguments:{path:'b.txt',content:'b'}},host(async()=>({ok:true}))),
        /ROOT_LEASED/
      );
      release();await first;
    }finally{s.close();}
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('v1 workflow database stays rollback-compatible until explicit post-cutover schema finalization',()=>{
  const root=temp();try{
    const dir=path.join(root,'memory');fs.mkdirSync(dir);
    const db=new DatabaseSync(path.join(dir,'workflows.sqlite'));
    db.exec(`
      CREATE TABLE workflows(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, head TEXT NOT NULL, snapshot TEXT NOT NULL);
      CREATE TABLE events(workflow TEXT NOT NULL REFERENCES workflows(id), seq INTEGER NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(workflow,seq));
      CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;
      CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;
      PRAGMA user_version=1;
    `);db.close();
    const s=new WorkflowStore(options(root));try{
      assert.equal(s.capabilities().schema,2);
      const check=new DatabaseSync(s.location,{readOnly:true});try{
        assert.equal(check.prepare('PRAGMA user_version').get().user_version,1);
        assert.equal(check.prepare('PRAGMA quick_check').get().quick_check,'ok');
        const names=check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name);
        for(const n of ['scheduler_jobs','operations','root_leases'])assert.ok(names.includes(n));
      }finally{check.close();}
    }finally{s.close();}
    const f=spawnSync(process.execPath,[finalizer,'--directory',dir],{encoding:'utf8'});
    assert.equal(f.status,0,f.stderr);
    const finalDb=new DatabaseSync(path.join(dir,'workflows.sqlite'),{readOnly:true});
    try{assert.equal(finalDb.prepare('PRAGMA user_version').get().user_version,2);assert.equal(finalDb.prepare('PRAGMA quick_check').get().quick_check,'ok');}
    finally{finalDb.close();}
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('user revision override revises goal/acceptance and stale worker is rejected',()=>{
  const root=temp();try{
    const s=new WorkflowStore(options(root));try{
      create(s,root);
      const updated=s.revise({id:'sample',expectedRevision:1,goal:'New user goal',acceptance:['new proof'],reason:'new user instruction'});
      assert.equal(updated.state.goal,'New user goal');assert.deepEqual(updated.state.acceptance,['new proof']);
      assert.throws(()=>s.revise({id:'sample',expectedRevision:1,goal:'stale',reason:'stale worker'}),/REVISION_CONFLICT/);
    }finally{s.close();}
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('verified NOT_APPLIED outcome cannot release an uncertain external-effect lease without cessation proof',async()=>{
  const root=temp();try{
    const s=new WorkflowStore(options(root));try{
      s.create({id:'retry',root,goal:'no blind replay',acceptance:['proof'],retryBudget:1,steps:[
        {id:'a',title:'A',dependsOn:[]},{id:'b',title:'B',dependsOn:[]}
      ]});
      const failHost=host(async()=>{throw Object.assign(new Error('same'),{workflowCode:'SAME_ROOT'});});
      const first=await s.call({id:'retry',stepId:'a',expectedRevision:1,tool:'write_text',arguments:{path:'a.txt',content:'a'}},failHost);
      assert.equal(first.outcome,'UNCERTAIN');
      assert.equal(s.get('retry').state.scheduler.repeatedFailureCount,1);
      const outcome=await s.reconcileAutomatically('retry',{verify:async()=>({status:'NOT_APPLIED',summary:'absent'})});
      assert.equal(outcome.status,'NOT_APPLIED');
      const st=s.get('retry').state;
      await assert.rejects(s.call({id:'retry',stepId:'b',expectedRevision:st.revision,tool:'write_text',arguments:{path:'b.txt',content:'b'}},failHost),
        /WORKFLOW_ROOT_LEASED/);
      const after=s.get('retry').state;
      assert.equal(after.scheduler.repeatedFailureCount,1);
      assert.equal(after.scheduler.lastRootCauseCode,'SAME_ROOT');
      assert.equal(after.scheduler.lastFailureCode,'WORKFLOW_REPLAN_REQUIRED');
      assert.equal(after.lifecycleState,'BLOCKED');
    }finally{s.close();}
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('same root-cause failures still exceed retry budget when root leases are disabled',async()=>{
  const root=temp();try{
    const opts=options(root);opts.schedulerPolicy.oneWriterPerRoot=false;
    const s=new WorkflowStore(opts);try{
      s.create({id:'retry-budget',root,goal:'budget',acceptance:['proof'],retryBudget:1,steps:[
        {id:'a',title:'A',dependsOn:[]},{id:'b',title:'B',dependsOn:[]}
      ]});
      const failHost=host(async()=>{throw Object.assign(new Error('same'),{workflowCode:'SAME_ROOT'});});
      const first=await s.call({id:'retry-budget',stepId:'a',expectedRevision:1,tool:'write_text',arguments:{path:'a.txt',content:'a'}},failHost);
      assert.equal(first.outcome,'UNCERTAIN');
      await s.reconcileAutomatically('retry-budget',{verify:async()=>({status:'NOT_APPLIED',summary:'absent'})});
      const st=s.get('retry-budget').state;
      await s.call({id:'retry-budget',stepId:'b',expectedRevision:st.revision,tool:'write_text',arguments:{path:'b.txt',content:'b'}},failHost);
      const after=s.get('retry-budget').state;
      assert.equal(after.scheduler.repeatedFailureCount,2);
      assert.equal(after.scheduler.lastRootCauseCode,'SAME_ROOT');
      assert.equal(after.scheduler.lastFailureCode,'BLOCKED_REQUIRES_REASSESSMENT');
      assert.equal(after.lifecycleState,'BLOCKED');
    }finally{s.close();}
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
