import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';

const root=path.resolve(import.meta.dirname,'..');
const cmd=path.join(root,'tools/universal-install/engine.mjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const run=(...args)=>{
  const r=spawnSync(process.execPath,[cmd,...args],{encoding:'utf8',timeout:20000,
    maxBuffer:2*1024*1024,windowsHide:true});
  assert.equal(r.error,undefined,String(r.error||''));
  const raw=r.status===0?r.stdout:r.stderr;
  return {code:r.status,value:JSON.parse(raw.trim()),raw};
};
function bundle(base,tag,commit){
  const dest=path.join(base,'bundle-'+tag);
  const payload=path.join(dest,'payload');
  fs.mkdirSync(payload,{recursive:true});
  const files=[];
  for(let i=0;i<101;i++){
    const name='src/feature-'+String(i).padStart(3,'0')+'.mjs';
    const data=Buffer.from('export const candidate='+JSON.stringify(tag+i)+';');
    const destFile=path.join(payload,...name.split('/'));
    fs.mkdirSync(path.dirname(destFile),{recursive:true});
    fs.writeFileSync(destFile,data);
    files.push({path:name,sha256:sha(data),bytes:data.length});
  }
  const canonical=files.map(x=>x.path+'\0'+x.sha256+'\0'+x.bytes+'\n').join('');
  fs.writeFileSync(path.join(dest,'manifest.json'),JSON.stringify({
    schema:'rc-universal-qa-v1',product:'ChatGPTRemoteCommander',train:'0.12',
    sourceCommit:commit,version:'0.12.0-dev.'+tag,files,digest:sha(canonical),
    fullPowerGrant:false,serviceChanges:false
  }));
  return dest;
}
test('one shared contract declares immutable technical identity and unsupported release gates',()=>{
  const c=run('--contract');
  assert.equal(c.code,0);
  assert.equal(c.value.profile.technicalIdentityImmutable,true);
  assert.equal(c.value.profile.ownerDisplayNameEditable,true);
  assert.equal(c.value.releaseAdmission.stablePublished,false);
  assert.equal(c.value.productionInstallEnabled,false);
  assert.equal(c.value.presentation.crossOsVisualParityAccepted,false);
  assert.deepEqual(c.value.commonActions,['package','verify','install','upgrade','rollback','status']);
  assert.deepEqual(Object.keys(c.value.platforms),['windows','linux']);
});
test('identical engine installs, upgrades and rolls back verified artifacts without touching Core',()=>{
  const temp=fs.mkdtempSync(path.join(os.homedir(),'rc-universal-engine-test-'));
  const target=path.join(temp,'rc-universal-qa-candidate');
  try{
    const v1=bundle(temp,'6','a'.repeat(40));
    const v2=bundle(temp,'9','b'.repeat(40));
    assert.equal(run('--verify-package','--bundle',v1).value.status,'QA_PACKAGE_VERIFIED');
    const first=run('--qa-install','--bundle',v1,'--target',target,
                    '--expected-commit','a'.repeat(40));
    assert.equal(first.code,0,first.raw);
    assert.equal(first.value.status,'QA_INSTALL_VERIFIED');
    assert.equal(first.value.version,'0.12.0-dev.6');
    assert.equal(first.value.realServicesStarted,false);
    assert.equal(first.value.ownerConsentGranted,false);
    const changed=run('--qa-upgrade','--bundle',v2,'--target',target,
                      '--expected-commit','b'.repeat(40));
    assert.equal(changed.code,0,changed.raw);
    assert.equal(changed.value.status,'QA_UPGRADE_VERIFIED');
    assert.equal(changed.value.version,'0.12.0-dev.9');
    assert.ok(changed.value.previous);
    const rollback=run('--qa-rollback','--target',target);
    assert.equal(rollback.code,0,rollback.raw);
    assert.equal(rollback.value.status,'QA_ROLLBACK_VERIFIED');
    assert.equal(rollback.value.version,'0.12.0-dev.6');
    const status=run('--qa-status','--target',target);
    assert.equal(status.code,0);
    assert.equal(status.value.version,'0.12.0-dev.6');
    assert.equal(status.value.revision,3);
    assert.equal(status.value.previous,changed.value.current);
    assert.equal(run('--qa-upgrade','--bundle',v2,'--target',target,
                     '--expected-commit','b'.repeat(40)).code,2);
    assert.equal(run('--qa-verify','--target',target).value.status,'QA_ACTIVE_VERIFIED');
    assert.equal(fs.existsSync(path.join(target,'routing')),false);
    assert.equal(fs.existsSync(path.join(target,'instances')),false);
    assert.equal(fs.existsSync(path.join(target,'credentials')),false);
  } finally {fs.rmSync(temp,{recursive:true,force:true,maxRetries:4,retryDelay:80});}
});
test('same engine rejects tampered package, false commit, alias and non-QA roots',()=>{
  const temp=fs.mkdtempSync(path.join(os.homedir(),'rc-universal-engine-guard-'));
  const target=path.join(temp,'rc-universal-qa-negative');
  try{
    const sample=bundle(temp,'7','c'.repeat(40));
    assert.equal(run('--qa-install','--bundle',sample,'--target',target,
                     '--expected-commit','d'.repeat(40)).code,2);
    assert.equal(run('--qa-install','--bundle',sample,'--target',path.join(temp,'production'),
                     '--expected-commit','c'.repeat(40)).code,2);
    const p=path.join(sample,'payload','src','feature-000.mjs');
    fs.appendFileSync(p,'// hijack');
    const denied=run('--qa-install','--bundle',sample,'--target',target,
                     '--expected-commit','c'.repeat(40));
    assert.equal(denied.code,2);
    assert.equal(denied.value.reason,'PACKAGE_FILE_HASH_MISMATCH');
    assert.equal(fs.existsSync(path.join(target,'active.json')),false);
  } finally {fs.rmSync(temp,{recursive:true,force:true,maxRetries:4,retryDelay:80});}
});
