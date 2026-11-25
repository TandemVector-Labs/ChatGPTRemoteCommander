import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const read=x=>fs.readFileSync(path.join(root,x),'utf8');
const contract=JSON.parse(read('installer/universal-install-contract.json'));
const release=JSON.parse(read('docs/release-train-0.12.json'));
const engine=read('tools/universal-install/engine.mjs');

test('one package contract covers both operating systems and all nine accepted components',()=>{
  assert.equal(contract.schema,'rc-unified-installer-v1');
  assert.deepEqual(Object.keys(contract.platforms),['windows','linux']);
  assert.equal(contract.sourceTrain,'0.12');
  assert.equal(new Set(contract.commonComponents).size,9);
  for(const c of contract.commonComponents)
    assert.ok(release.components.find(x=>x.id===c && x.required===true),c);
  assert.deepEqual(contract.commonActions,['package','verify','install','upgrade','rollback','status']);
  assert.equal(contract.nativeCandidateRoot,'packaging/unified');
  assert.equal(contract.qaTransactionHelper,'tools/universal-install/engine.mjs');
  for(const f of contract.requiredEmbeddedCoreFiles)
    assert.ok(contract.requiredSourceFiles.includes(f) || f==='config.json',f);
  const native=read('packaging/unified/prepare.mjs');
  assert.match(native,/requiredEmbeddedCoreFiles/u);
  assert.match(native,/UNIFIED_CANDIDATE_CONTRACT_INVALID/u);
  assert.match(native,/unifiedContract\.presentation\?\.crossOsVisualParityAccepted/u);
  for(const p of contract.requiredSourceFiles)
    assert.ok(fs.existsSync(path.join(root,p)),p);
});

test('immutable public Core tar omits optional extension bundle path',()=>{
 const native=read('packaging/unified/prepare.mjs');
 assert.match(native,/'archive','--format=tar','--output',tar,head,\s*'src','tools','vendor','assets','config\.json','package\.json'/u);
 assert.doesNotMatch(native,/'archive','--format=tar','--output',tar,head,\s*'src','tools','vendor','assets','extensions'/u);
});

test('an exact-source installer QA pass cannot authorize v0.12 stable or all-account Full Power',()=>{
  assert.equal(release.publishApproved,false);
  assert.equal(release.installedPromotionApproved,false);
  assert.equal(contract.releaseAdmission.stablePublished,false);
  assert.equal(contract.presentation.crossOsVisualParityAccepted,false);
  assert.equal(contract.profile.fullPowerIsNotOsElevation,true);
  assert.equal(contract.profile.independentAccountTunnel,true);
  assert.match(engine,/realServicesStarted:false,ownerConsentGranted:false/u);
  assert.match(engine,/productionInstallEnabled:false/u);
  assert.match(engine,/releasePath\(target,state\.previous\)/u);
  assert.match(engine,/core\.autocrlf=false/u);
  assert.match(engine,/core\.eol=lf/u);
  assert.doesNotMatch(engine,/systemctl|schtasks|reg\.exe|sudo|winget|npm\s+install/u);
});

test('native Windows/Linux matrix requires exact-file equality before installer acceptance',()=>{
  const y=read('.github/workflows/unified-installer-pilot.yml');
  for(const marker of ['exact-source-parity:', 'needs: [package]',
    'rc012-native-core-Windows','rc012-native-core-Linux',
    'verify-native-parity.mjs','--expected-commit',
    'packaging/unified/.stage/core/source-manifest.json']){
    assert.ok(y.includes(marker), marker);
  }
  assert.match(y,/os: \[ubuntu-latest, windows-latest\]/);
  assert.ok(y.includes('include-hidden-files: true'));
  const deps=read('package.json');
  assert.ok(deps.includes('test/universal-native-parity.test.mjs'));
});

test('source regression owner-recovery batches respect native test deadlines without dropping coverage',()=>{
  const source=read('tools/run-v012-source-regression.mjs');
  assert.match(source,/files\.slice\(20, 21\).*Protected Core/);
  assert.match(source,/files\.slice\(21, 22\).*Windows DPAPI recovery/);
  assert.match(source,/files\.slice\(22, 23\).*Linux encrypted recovery/);
  assert.match(source,/index === 13 \? 100000/);
  assert.match(source,/index === 14 \? \(part === 0 \? 55000 : 65000\)/);
  assert.match(source,/new Set\(batches\.flat\(\)\)\.size!==files\.length/);
});
