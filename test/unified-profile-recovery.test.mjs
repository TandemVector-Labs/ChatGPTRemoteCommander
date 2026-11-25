import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {stageProfileRecovery,planProfileRollback} from '../packaging/unified/profile-recovery-capsule.mjs';

const sha=s=>createHash('sha256').update(s).digest('hex');
function fixture(){
 const owner=fs.mkdtempSync(path.join(os.tmpdir(),'rc012-recovery-'));
 fs.chmodSync(owner,0o700);
 const src=path.join(owner,'profiles'),backup=path.join(owner,'private');
 fs.mkdirSync(src,{mode:0o700});fs.mkdirSync(backup,{mode:0o700});
 fs.mkdirSync(path.join(src,'owner'),{mode:0o700});
 fs.mkdirSync(path.join(src,'systemd'),{mode:0o700});
 fs.writeFileSync(path.join(src,'owner/config.json'),'{"private":"test-only-synthetic"}\n',{mode:0o600});
 fs.writeFileSync(path.join(src,'systemd/commander.service'),'[Service]\nExecStart=/some/old/runtime\n',{mode:0o600});
 return {ownerRoot:owner,sourceRoot:src,recoveryRoot:backup,
   relativeFiles:['owner/config.json','systemd/commander.service'],
   dispose:()=>fs.rmSync(owner,{recursive:true,force:true})};
}
test('bounded private backup is created once and does not modify the active sources',()=>{
 const f=fixture();
 try{
   const originals=f.relativeFiles.map(p=>fs.readFileSync(path.join(f.sourceRoot,p)));
   const a=stageProfileRecovery(f);
   assert.equal(a.schema,1);assert.equal(a.reused,false);
   assert.equal(a.files,2);assert.equal(a.changesToSource,false);
   assert.equal(a.baseline['owner/config.json'],sha(originals[0]));
   const b=stageProfileRecovery(f);
   assert.equal(b.reused,true);assert.equal(b.receiptSha256,a.receiptSha256);
   assert.deepEqual(f.relativeFiles.map(p=>fs.readFileSync(path.join(f.sourceRoot,p))),originals);
   if(process.platform!=='win32'){
     const stat=fs.statSync(path.join(f.recoveryRoot,'rc012-config-recovery/receipt.json'));
     assert.equal(stat.mode&0o077,0);
   }
 }finally{f.dispose();}
});
test('rollback generates no-write plan only when current hashes match',()=>{
 const f=fixture();
 try{
   stageProfileRecovery(f);
   const newer='{"private":"changed-only-in-fixture"}\n';
   fs.writeFileSync(path.join(f.sourceRoot,'owner/config.json'),newer);
   const hashes=Object.fromEntries(f.relativeFiles.map(p=>[p,sha(fs.readFileSync(path.join(f.sourceRoot,p)))]));
   const plan=planProfileRollback({...f,expectedCurrentHashes:hashes});
   assert.equal(plan.decision,'ROLLBACK_PLAN_ONLY');
   assert.equal(plan.recoveryVerified,true);assert.equal(plan.canRestore,false);
   assert.equal(plan.nativeOwnerConsentRequired,true);
   assert.equal(fs.readFileSync(path.join(f.sourceRoot,'owner/config.json'),'utf8'),newer);
   fs.writeFileSync(path.join(f.sourceRoot,'owner/config.json'),'different');
   assert.throws(()=>planProfileRollback({...f,expectedCurrentHashes:hashes}),
     /RC012_RECOVERY_CHANGED_AFTER_PLAN/);
 }finally{f.dispose();}
});
test('tampered capsule, duplicate inventory and mismatched baselines fail closed',()=>{
 const f=fixture();
 try{
   stageProfileRecovery(f);
   assert.throws(()=>stageProfileRecovery({...f,relativeFiles:['owner/config.json','owner/config.json']}),
     /RC012_RECOVERY_DUPLICATE/);
   assert.throws(()=>stageProfileRecovery({...f,relativeFiles:['owner/config.json']}),
     /RC012_RECOVERY_EXISTING_INVENTORY_DIFFERENT/);
   const saved=path.join(f.recoveryRoot,'rc012-config-recovery/files/owner/config.json');
   fs.appendFileSync(saved,'tamper');
   assert.throws(()=>stageProfileRecovery(f),/RC012_RECOVERY_DATA_TAMPERED/);
 }finally{f.dispose();}
});
test('size, parent traversal and symlink-like paths are rejected',()=>{
 const f=fixture();
 try{
   for(const rel of ['../escape.json','/tmp/any.json','owner\\config.json','x/../../no.json','owner/config.key','owner/settings.json:stream.json','owner/a?.json']){
     assert.throws(()=>stageProfileRecovery({...f,relativeFiles:[rel]}),/RC012_RECOVERY_RELATIVE_INVALID/);
   }
   fs.writeFileSync(path.join(f.sourceRoot,'oversize.json'),'X'.repeat(1024*1024+1));
   assert.throws(()=>stageProfileRecovery({...f,relativeFiles:['oversize.json']}),
     /RC012_RECOVERY_SOURCE_NOT_SMALL_FILE/);
   if(process.platform!=='win32'){
     fs.symlinkSync(path.join(f.sourceRoot,'owner/config.json'),path.join(f.sourceRoot,'link.json'));
     assert.throws(()=>stageProfileRecovery({...f,relativeFiles:['link.json']}),/RC012_RECOVERY_SYMLINK_REFUSED/);
   }
 }finally{f.dispose();}
});
test('refuses backup root outside owner scope and incompatible source roots',()=>{
 const f=fixture();
 const other=fs.mkdtempSync(path.join(os.tmpdir(),'rc012-other-'));
 try{
   assert.throws(()=>stageProfileRecovery({...f,recoveryRoot:other}),/RC012_RECOVERY_ROOT_OVERLAP/);
   assert.throws(()=>stageProfileRecovery({...f,recoveryRoot:f.sourceRoot}),/RC012_RECOVERY_ROOT_OVERLAP/);
 }finally{fs.rmSync(other,{recursive:true,force:true});f.dispose();}
});

test('private credentials and tokens are never copied into the plain recovery capsule',()=>{
 const f=fixture();
 try{
   const src=path.join(f.sourceRoot,'owner/config.json');
   fs.writeFileSync(src,JSON.stringify({nested:{accessToken:'synthetic-test-secret'}}));
   assert.throws(()=>stageProfileRecovery(f),/RC012_RECOVERY_INLINE_SECRET_REFUSED/);
   assert.equal(fs.existsSync(path.join(f.recoveryRoot,'rc012-config-recovery')),false);
   fs.writeFileSync(src,JSON.stringify({ui:{theme:'dark'}}));
   const service=path.join(f.sourceRoot,'systemd/commander.service');
   fs.writeFileSync(service,'[Service]\nEnvironment=PASSWORD=synthetic\n');
   assert.throws(()=>stageProfileRecovery(f),/RC012_RECOVERY_INLINE_SECRET_REFUSED/);
   assert.equal(fs.existsSync(path.join(f.recoveryRoot,'rc012-config-recovery')),false);
 }finally{f.dispose();}
});
