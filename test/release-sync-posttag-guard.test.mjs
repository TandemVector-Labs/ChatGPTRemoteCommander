import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {verifyV012Publication,summarizeV012Readiness} from '../tools/verify-v012-publish-readiness.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const normalizeNewlines=text=>text.replace(/\r\n?/g,'\n');
const workflow=normalizeNewlines(fs.readFileSync(path.join(root,'.github/workflows/release-sync.yml'),'utf8'));
const start=workflow.indexOf('      - name: Validate matching annotated tag and versioned 20/21-asset manifest');
const end=workflow.indexOf('      - name: Authorize Windows distribution mode for this exact version',start);
assert.ok(start>0&&end>start,'release identity step not found');
const block=workflow.slice(start,end);
const runPos=block.indexOf('        run: |');
assert.ok(runPos>=0,'release identity script missing');
const script=block.slice(runPos+'        run: |'.length).split(/\r?\n/).map(l=>l.startsWith('          ')?l.slice(10):l).join('\n');
// Bind the reviewed workflow shell program to an exact source hash; the
// fixture never passes unverified repository text to a shell's -c argument.
// Reviewed 2026-11-22: only added a fail-closed v0.12 readiness check before accepted=true.
const APPROVED_SCRIPT_SHA256='91021ba7ab747334e67ce06785b0fd244bb0db0e4676748ce76db40ce7cd9915';
assert.equal(crypto.createHash('sha256').update(script).digest('hex'),APPROVED_SCRIPT_SHA256,
 'release policy script changed; re-review the source before testing');
assert.ok(script.includes('R171_POSTTAG_MAIN_SKIP'));
assert.ok(script.includes('R171_TAG_SOURCE_MISMATCH'));
assert.ok(script.includes('test "$count" -eq "$expected_count"'));
assert.ok(script.includes('expected_count=20'));
assert.ok(script.includes('then expected_count=21; fi'));
assert.ok(workflow.includes("steps.release_identity.outputs.accepted == 'true'"));
test('Release Sync skips stable asset publisher on ordinary main development pushes',()=>{
 const section=workflow.match(/^  publish:\n    if: ([^\n]+)/m);
 assert.ok(section,'publish job and explicit event guard required');
 assert.match(section[1],/github\.event_name\s*==\s*'push'/);
 assert.match(section[1],/startsWith\(github\.ref,\s*'refs\/tags\/v'\)/);
 assert.doesNotMatch(section[1],/github\.ref\s*!=/);
});

const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8'});
test('R171 tag-only publication gate skips post-tag main without re-signing or retagging',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rc-posttag-r171-'));
 t.after(()=>{assert.match(path.basename(dir),/^rc-posttag-r171-/);fs.rmSync(dir,{recursive:true,force:true});});
 const bash=process.platform==='win32'?'C:\\Program Files\\Git\\bin\\bash.exe':'bash';
 if(process.platform==='win32'&&!fs.existsSync(bash))return t.skip('Git Bash unavailable on Windows');
 const repo=path.join(dir,'repo');fs.mkdirSync(repo,{recursive:true});
 git(repo,'init','-q');fs.writeFileSync(path.join(repo,'package.json'),JSON.stringify({version:'0.10.25'}));
 fs.mkdirSync(path.join(repo,'docs'));fs.writeFileSync(path.join(repo,'docs','RELEASE_0.10.25.md'),'release fixture');
 const assets=path.join(repo,'dist','release');fs.mkdirSync(assets,{recursive:true});
 for(let i=0;i<19;i++)fs.writeFileSync(path.join(assets,'asset-'+i+'.txt'),'asset '+i);
 // Compute a proper SHA-256 manifest from native Node, with portable two-space filename separator.
 const sums=[];
 for(let i=0;i<19;i++){const n='asset-'+i+'.txt';sums.push(crypto.createHash('sha256').update(fs.readFileSync(path.join(assets,n))).digest('hex')+'  '+n);}
 fs.writeFileSync(path.join(assets,'SHA256SUMS.txt'),sums.join('\n')+'\n');
 git(repo,'add','.');git(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','release fixture');
 git(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','tag','-a','v0.10.25','-m','annotated release');
 const program=path.join(dir,'approved-release-policy.sh');
 fs.writeFileSync(program,script,{mode:0o600});
 const output=path.join(dir,'result.txt');
 const invoke=(event,ref)=>{
   fs.writeFileSync(output,'');
   const env={...process.env,GITHUB_OUTPUT:output,GITHUB_EVENT_NAME:event,GITHUB_REF:ref};
   const r=spawnSync(bash,[program],{cwd:repo,env,encoding:'utf8',timeout:16000});
   assert.equal(r.error,undefined,String(r.error));
   return {r,output:fs.readFileSync(output,'utf8')};
 };
 const original=invoke('push','refs/tags/v0.10.25');
 assert.equal(original.r.status,0,original.r.stderr);
 assert.match(original.output,/accepted=true/);
 assert.match(original.r.stdout,/R171_IMMUTABLE_TAG_AND_ASSETS_PREATTEST_PASS/);
 fs.writeFileSync(path.join(repo,'new-feature.txt'),'new main feature');
 git(repo,'add','.');git(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','post tag dev');
 const later=invoke('push','refs/heads/main');
 assert.equal(later.r.status,0,later.r.stderr);
 assert.match(later.output,/accepted=false/);
 assert.match(later.r.stdout,/R171_POSTTAG_MAIN_SKIP/);
 assert.doesNotMatch(later.r.stdout,/R171_IMMUTABLE_TAG_AND_ASSETS_PREATTEST_PASS/);
 const wrongTag=invoke('push','refs/tags/v0.10.25');
 assert.notEqual(wrongTag.r.status,0);
 assert.match(wrongTag.r.stdout,/R171_TAG_SOURCE_MISMATCH/);
 assert.doesNotMatch(wrongTag.output,/accepted=true/);
 const wrongEvent=invoke('workflow_dispatch','refs/heads/main');
 assert.notEqual(wrongEvent.r.status,0);
 assert.match(wrongEvent.r.stdout,/R171_TAG_SOURCE_MISMATCH/);
 git(repo,'tag','-d','v0.10.25');
 const missing=invoke('push','refs/heads/main');
 assert.equal(missing.r.status,0,missing.r.stderr);
 assert.match(missing.r.stdout,/R171_NO_TAG_SKIP/);
 assert.match(missing.output,/accepted=false/);
});


test('0.12 readiness report exposes all blockers read-only without claiming installed acceptance',()=>{
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'docs','release-train-0.12.json'),'utf8'));
 const report=summarizeV012Readiness(manifest);
 assert.equal(report.schema,'rc-v012-readiness-report-v1');
 assert.equal(report.manifestEligibilityOnly,false);
 assert.equal(report.externalEvidenceRequired,true);
 assert.equal(report.verifiedComponents,0);
 assert.equal(report.requiredComponents,9);
 assert.equal(report.verifiedAcceptance,0);
 assert.equal(report.requiredAcceptance,9);
 assert.equal(report.expectedHostCount,8);
 assert.equal(report.acceptedHostCount,0);
 assert.equal(report.missingHosts.length,8);
 assert.equal(report.mappingVerified,false);
 assert.equal(report.bootLoginAndRollbackVerified,false);
 const cli=spawnSync(process.execPath,[
   path.join(root,'tools/verify-v012-publish-readiness.mjs'),'--report'
 ],{cwd:root,encoding:'utf8',timeout:9000});
 assert.equal(cli.status,0,cli.stderr);
 assert.deepEqual(JSON.parse(cli.stdout),report);
 const invalid=spawnSync(process.execPath,[
   path.join(root,'tools/verify-v012-publish-readiness.mjs'),'--report','v0.12.0'
 ],{cwd:root,encoding:'utf8',timeout:9000});
 assert.equal(invalid.status,2);
});

test('V1-08 v0.12 release requires exact accepted train before attestation and draft creation',()=>{
 const gate='node tools/verify-v012-publish-readiness.mjs "$version" "$tag"';
 assert.ok(script.includes(gate));
 assert.ok(script.indexOf(gate)<script.indexOf('accepted=true'));
 assert.equal(workflow.split(gate).length-1,2,'gate must guard identity and draft publication');
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'docs/release-train-0.12.json'),'utf8'));
 assert.throws(()=>verifyV012Publication('0.12.0-dev.1','v0.12.0-dev.1',manifest),
   /V108_V012_RELEASE_APPROVAL_DENIED/);
 assert.throws(()=>verifyV012Publication('0.12.0','v0.12.0',manifest),
   /V108_V012_RELEASE_APPROVAL_DENIED/);
 const current=spawnSync(process.execPath,
   [path.join(root,'tools/verify-v012-publish-readiness.mjs'),'0.12.0','v0.12.0'],
   {cwd:root,encoding:'utf8',timeout:10000});
 assert.equal(current.status,2,'current development manifest must fail closed');
 assert.match(current.stderr,/V108_V012_PUBLICATION_DENIED/);
 const ready={
   ...manifest,sourceVersion:'0.12.0',status:'RELEASE_APPROVED',
   channel:'release',isStable:true,publishApproved:true,
   autoupdateApproved:true,installedPromotionApproved:true,releaseTag:'v0.12.0',
   components:manifest.components.map(x=>({...x,verified:true})),
   acceptance:Object.fromEntries(Object.keys(manifest.acceptance).map(k=>[k,true])),
   fleetCoverage:{...manifest.fleetCoverage,
     acceptedHostIds:[...manifest.fleetCoverage.expectedHostIds],
     mappingVerified:true,bootLoginAndRollbackVerified:true},
   distribution:{...manifest.distribution,noPublicStableAccepted:false}
 };
 assert.equal(verifyV012Publication('0.12.0','v0.12.0',ready),
   'V108_V012_RELEASE_APPROVED_MANIFEST_PASS');
 for(const patch of [
   {publishApproved:false},{autoupdateApproved:false},
   {installedPromotionApproved:false},{status:'INTEGRATION_CANDIDATE_NOT_FINAL'},
   {sourceVersion:'0.12.0-dev.1'},{releaseTag:null},
   {distribution:{...ready.distribution,noPublicStableAccepted:true}},
   {acceptance:{...ready.acceptance,authAndGui:false}},
   {acceptance:{...ready.acceptance,rollback:false}},
   {components:ready.components.map(x=>x.id==='gui-same-owner'?{...x,verified:false}:x)},
   {components:ready.components.slice(1)},{fleet:['EmadPC']},
   {firstStable:'1.0.0'},{majorTarget:'0.12.0'},
   {fleetCoverage:{...ready.fleetCoverage,mappingVerified:false}},
   {fleetCoverage:{...ready.fleetCoverage,bootLoginAndRollbackVerified:false}},
   {fleetCoverage:{...ready.fleetCoverage,acceptedHostIds:ready.fleetCoverage.acceptedHostIds.slice(1)}},
   {fleetCoverage:{...ready.fleetCoverage,acceptedHostIds:['UNKNOWN',...ready.fleetCoverage.acceptedHostIds.slice(1)]}}
 ]){
   assert.throws(()=>verifyV012Publication('0.12.0','v0.12.0',{...ready,...patch}),
     /V108_V012_RELEASE_APPROVAL_DENIED/);
 }
 assert.throws(()=>verifyV012Publication('0.12.0','v0.12.1',ready),
   /V108_V012_RELEASE_APPROVAL_DENIED/);
});


test('v0.12 annotated tag cannot bypass NoPromote train in actual release identity Bash',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rc-v012-release-gate-'));
 t.after(()=>{assert.match(path.basename(dir),/^rc-v012-release-gate-/);fs.rmSync(dir,{recursive:true,force:true});});
 const bash=process.platform==='win32'?'C:\\Program Files\\Git\\bin\\bash.exe':'bash';
 if(process.platform==='win32'&&!fs.existsSync(bash))return t.skip('Git Bash unavailable');
 const repo=path.join(dir,'repo');
 fs.mkdirSync(repo,{recursive:true});
 git(repo,'init','-q');
 fs.writeFileSync(path.join(repo,'package.json'),JSON.stringify({version:'0.12.0'})+'\n');
 fs.mkdirSync(path.join(repo,'docs'));
 fs.writeFileSync(path.join(repo,'docs','RELEASE_0.12.0.md'),'synthetic release notes\n');
 fs.copyFileSync(path.join(root,'docs','release-train-0.12.json'),
   path.join(repo,'docs','release-train-0.12.json'));
 fs.mkdirSync(path.join(repo,'tools'));
 fs.copyFileSync(path.join(root,'tools','verify-v012-publish-readiness.mjs'),
   path.join(repo,'tools','verify-v012-publish-readiness.mjs'));
 const assets=path.join(repo,'dist','release');
 fs.mkdirSync(assets,{recursive:true});
 const sums=[];
 for(let i=0;i<20;i++){
   const name='test-asset-'+i+'.txt';
   fs.writeFileSync(path.join(assets,name),'asset '+i);
   sums.push(crypto.createHash('sha256').update(fs.readFileSync(path.join(assets,name))).digest('hex')+'  '+name);
 }
 fs.writeFileSync(path.join(assets,'SHA256SUMS.txt'),sums.join('\n')+'\n');
 git(repo,'add','.');
 git(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid',
   'commit','-qm','synthetic tag for publication gate regression');
 git(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid',
   'tag','-a','v0.12.0','-m','synthetic not-approved tag');
 const out=path.join(dir,'result.txt');
 fs.writeFileSync(out,'');
 const result=spawnSync(bash,['-s'],{input:script,
   cwd:repo,env:{...process.env,GITHUB_OUTPUT:out,GITHUB_EVENT_NAME:'push',
     GITHUB_REF:'refs/tags/v0.12.0'},encoding:'utf8',timeout:16000
 });
 assert.equal(result.error,undefined,String(result.error));
 assert.notEqual(result.status,0,'NoPromote tagged source cannot be accepted');
 assert.match(result.stderr,/V108_V012_PUBLICATION_DENIED/);
 assert.doesNotMatch(result.stdout,/R171_IMMUTABLE_TAG_AND_ASSETS_PREATTEST_PASS/);
 assert.doesNotMatch(fs.readFileSync(out,'utf8'),/accepted=true/);
});


test('release-sync PR path guard tolerates hosted Windows CRLF checkout',()=>{
 const windowsText=workflow.replace(/\n/g,'\r\n');
 const normalized=normalizeNewlines(windowsText);
 const pr=normalized.split('  pull_request:\n')[1]?.split('\npermissions:')[0];
 assert.ok(pr,'Windows CRLF must not hide release-sync pull_request triggers');
 for(const f of ['docs/release-train-0.12.json','tools/verify-v012-publish-readiness.mjs','test/release-sync-posttag-guard.test.mjs'])
   assert.ok(pr.includes("      - '"+f+"'"),f);
});
test('release-sync PR scope includes development-train admission policy and regression test',()=>{
 const pr=workflow.split('  pull_request:\n')[1]?.split('\npermissions:')[0];
 assert.ok(pr,'pull_request path filter missing');
 for(const path of [
  'docs/release-train-0.11.json','docs/release-train-0.12.json',
  'tools/verify-v012-publish-readiness.mjs',
  'test/release-sync-posttag-guard.test.mjs'
 ])assert.ok(pr.includes("      - '"+path+"'"),'missing release-sync PR trigger '+path);
});

test('v0.12 development QA provenance uses a separate trusted integration-only job and cannot publish Stable',()=>{
 assert.match(workflow,/branches: \[main, integration\/v012-unsigned-approval-20261110\]/);
 const qa=workflow.split('  qa-provenance:\n')[1]?.split('\n  publish:\n')[0];
 assert.ok(qa,'QA attestation job must be independently scoped');
 assert.match(qa,/if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/integration\/v012-unsigned-approval-20261110'/);
 assert.match(qa,/needs: \[build-windows-setup, build-linux-bootstrap\]/);
 for(const field of ['contents: read','id-token: write','attestations: write',
   "remote-commander-windows-setup","remote-commander-linux-onefile-QA",
   "test \"$(git rev-parse HEAD)\" = \"$GITHUB_SHA\"",
   'train_version=',
   'test "$version" = "$train_version"',
   'node tools/isolated-qa-policy.mjs > /dev/null',
   "test \"$expected\" = \"$actual\"",
   'actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6',
   'create-storage-record: false','--source-digest "$GITHUB_SHA"',
   '--signer-workflow "$GH_REPO/.github/workflows/release-sync.yml"',
   'V012_QA_GITHUB_ATTESTATION_VERIFIED_NO_PROMOTE'])
   assert.ok(qa.includes(field),'missing QA attestation safety gate: '+field);
 const publish=workflow.split('  publish:\n')[1];
 assert.ok(publish?.includes("if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')"),
   'publishing job must refuse the development integration branch');
 assert.ok(publish.includes("steps.release_identity.outputs.accepted == 'true'"),
   'Stable tag-only publication gate must remain intact');
});
