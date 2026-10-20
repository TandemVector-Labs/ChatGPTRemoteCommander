import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {evaluateWindowsRelease} from '../tools/verify-windows-release-policy.mjs';

const policy=JSON.parse(readFileSync('docs/UNSIGNED_WINDOWS_RELEASE_POLICY.json','utf8'));
const releaseNotes=readFileSync('docs/RELEASE_0.10.23.md','utf8');
const example={signed:'false',version:'0.10.23',tag:'v0.10.23',policy,releaseNotes};

test('exact owner-acknowledged unsigned tag needs provenance',()=>{
 const a=evaluateWindowsRelease(example);
 assert.equal(a.allowed,true);
 assert.equal(a.mode,'UNSIGNED_WITH_REQUIRED_SIGSTORE_PROVENANCE');
});
test('already trusted signer can use signed path independent of temporary exception',()=>{
 const a=evaluateWindowsRelease({...example,signed:'true',version:'0.11.0',tag:'v0.11.0'});
 assert.equal(a.mode,'AUTHENTICODE_SIGNED');
});
test('reject future unsigned version without fresh scope decision',()=>{
 assert.throws(()=>evaluateWindowsRelease({...example,version:'0.10.24',tag:'v0.10.24'}),/WINDOWS_UNSIGNED_RELEASE_NOT_AUTHORIZED/);
});
test('reject fake or unchecked signer status',()=>{
 for(const signed of ['','unknown','NotSigned','True','FALSE'])
  assert.throws(()=>evaluateWindowsRelease({...example,signed}),/WINDOWS_RELEASE_SIGNATURE_STATUS_UNVERIFIED/);
});
test('reject mismatched tag, missing explicit permission and widened policy',()=>{
 assert.throws(()=>evaluateWindowsRelease({...example,tag:'v0.10.20'}),/WINDOWS_RELEASE_TAG_VERSION_MISMATCH/);
 for(const delta of [{allowUnsignedWithGitHubAttestation:false},{scope:'all-versions'},{publishedInstallerSignature:'Valid'},{riskAcknowledgement:''},{verification:''}]){
  assert.throws(()=>evaluateWindowsRelease({...example,policy:{...policy,...delta}}),/WINDOWS_UNSIGNED_RELEASE_NOT_AUTHORIZED/);
 }
});
test('require visible user warnings in release notes',()=>{
 for(const needle of ['Windows installer: UNSIGNED','SmartScreen','GitHub attestation']){
  assert.throws(()=>evaluateWindowsRelease({...example,releaseNotes:releaseNotes.replaceAll(needle,'')}),
   /WINDOWS_UNSIGNED_RELEASE_RISK_NOTICE_MISSING/);
 }
});
test('on-disk CLI supports version-specific unsigned and refuses future unsigned',()=>{
 const env={...process.env,SETUP_SIGNED:'false',RELEASE_VERSION:'0.10.23',RELEASE_TAG:'v0.10.23'};
 const ok=spawnSync(process.execPath,['tools/verify-windows-release-policy.mjs'],{encoding:'utf8',env});
 assert.equal(ok.status,0,ok.stderr);
 assert.match(ok.stdout,/UNSIGNED_WITH_REQUIRED_SIGSTORE_PROVENANCE/);
 const bad=spawnSync(process.execPath,['tools/verify-windows-release-policy.mjs'],{
  encoding:'utf8',env:{...env,RELEASE_VERSION:'0.10.24',RELEASE_TAG:'v0.10.24'}});
 assert.notEqual(bad.status,0);
 assert.match(bad.stderr,/WINDOWS_RELEASE_DISTRIBUTION_POLICY_DENIED/);
});

test('CLI rejects hostile version before any release-policy file access',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const cwd=mkdtempSync(join(tmpdir(),'release-policy-version-validation-'));
 try {
  const cli=new URL('../tools/verify-windows-release-policy.mjs',import.meta.url);
  for(const version of ['../../outside','0.10.23\n','0.10.23/../../outside','0.10.23\u2028','', '0.10.23.1']) {
   const out=spawnSync(process.execPath,[cli.pathname],{
    cwd,encoding:'utf8',
    env:{...process.env,SETUP_SIGNED:'false',RELEASE_VERSION:version,RELEASE_TAG:'v'+version}
   });
   assert.notEqual(out.status,0,version);
   assert.match(out.stderr,/WINDOWS_RELEASE_TAG_VERSION_MISMATCH/,version);
   assert.doesNotMatch(out.stderr,/ENOENT|EACCES/,version);
  }
  const valid=spawnSync(process.execPath,[cli.pathname],{
   cwd,encoding:'utf8',
   env:{...process.env,SETUP_SIGNED:'false',RELEASE_VERSION:'0.10.23',RELEASE_TAG:'v0.10.23'}
  });
  assert.equal(valid.status,0,valid.stderr);
  assert.match(valid.stdout,/UNSIGNED_WITH_REQUIRED_SIGSTORE_PROVENANCE/);
 }finally{rmSync(cwd,{recursive:true,force:true});}
});
