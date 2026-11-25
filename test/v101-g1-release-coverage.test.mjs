import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {
  assessG1ReleaseBundle,parseArgs,G1_MODULES,G1_TRUST_ASSETS_SHA256,
  V101_ACCEPTED_ADAPTER_SHA256,V102_ACCEPTED_WIN_JOB_SHA256,J01_VERIFIER_SHA256
} from '../tools/v1-01/verify-g1-release-coverage.mjs';

const base=fileURLToPath(new URL('../',import.meta.url));
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v101-release-source-gate-'));
  fs.writeFileSync(path.join(root,'package.json'),
    JSON.stringify({name:'candidate',version:'0.11.0-dev.23'}));
  for(const relative of G1_MODULES){
    const dest=path.join(root,relative);
    fs.mkdirSync(path.dirname(dest),{recursive:true});
    if(relative==='src/v101-v2-protected-dispatcher.mjs'||Object.hasOwn(J01_VERIFIER_SHA256,relative)){
      fs.copyFileSync(path.join(base,relative),dest);
    }else{
      fs.writeFileSync(dest,'// source coverage fixture, not production runtime\n');
    }
  }
  for(const rel of Object.keys(G1_TRUST_ASSETS_SHA256)){
    const dest=path.join(root,rel);
    fs.mkdirSync(path.dirname(dest),{recursive:true});
    fs.copyFileSync(path.join(base,rel),dest);
  }
  return root;
}
const assess=(root,platform='linux')=>assessG1ReleaseBundle({root,
  minimumVersion:'0.11.0-dev.23',platform});
test('exact V1-01 adapter digest is pinned to independently reviewed source',()=>{
  const actual=createHash('sha256').update(
    fs.readFileSync(path.join(base,'src/v101-v2-protected-dispatcher.mjs'))
  ).digest('hex');
  assert.equal(actual,V101_ACCEPTED_ADAPTER_SHA256);
  assert.match(V102_ACCEPTED_WIN_JOB_SHA256,/^[a-f0-9]{64}$/);
});
test('source coverage is not authenticated G1 even when every required module is present',()=>{
  const root=fixture();
  try{
    const r=assess(root);
    assert.equal(r.status,'SOURCE_COVERAGE_PASS_NOT_G1_ACCEPTANCE');
    assert.equal(r.countChecked,G1_MODULES.length);
    assert.equal(r.j01CredentialEnrolled,false);
    assert.equal(r.j01NativeSignerAccepted,false);
    for(const key of ['productionG1Accepted','authenticatedCallerProved',
      'nativeOwnerGrantProved','installedIngressProved','signedChatIdentityProved',
      'rollbackProved','operationalFullAccessProved'])
      assert.equal(r[key],false);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('release omitting one V2 or owner adapter module is always blocked',()=>{
  const root=fixture();
  try{
    for(const relative of [
      'src/native-owner-session-provider-windows.mjs',
      'src/native-owner-session-windows.ps1',
      'src/v101-windows-owner-security-bootstrap.mjs',
      'src/v101-g1-loopback-runtime.mjs',
      'src/v101-g1-canonical-workflow-runtime.mjs',
      'src/v101-private-tunnel-owner-host.mjs',
      'src/v2-private-tunnel-https-gateway.mjs',
      'src/v2-private-tunnel-mtls-attestor.mjs',
      'src/v2-mcp-http-ingress.mjs','src/v2-oauth-jwks.mjs',
      'src/v2-native-owner-session-bindings.mjs',
      'src/v101-v2-protected-dispatcher.mjs',
      'src/gui-j01-owner-grant-verifier.mjs',
      'src/gui-j01-webauthn-verifier.mjs'
    ]){
      const f=path.join(root,relative),original=fs.readFileSync(f);
      fs.rmSync(f);
      const r=assess(root);
      assert.equal(r.status,'BLOCKED');
      assert.equal(r.code,'G1_MODULES_OMITTED_FROM_RELEASE');
      assert.ok(r.missing.includes(relative));
      fs.writeFileSync(f,original);
    }
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('modified owner adapter and backwards version are rejected',()=>{
  const root=fixture();
  try{
    const adapter=path.join(root,'src/v101-v2-protected-dispatcher.mjs');
    fs.appendFileSync(adapter,'\n// altered after acceptance\n');
    assert.equal(assess(root).code,'V101_ADAPTER_NOT_PINNED');
    fs.copyFileSync(path.join(base,'src/v101-v2-protected-dispatcher.mjs'),adapter);
    fs.writeFileSync(path.join(root,'package.json'),
      JSON.stringify({name:'old-release',version:'0.11.0-dev.15'}));
    assert.equal(assess(root).code,'DOWNGRADE_OR_STALE_RELEASE');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('Windows source requires exact manifest and native Job Object executable',()=>{
  const root=fixture();
  try{
    assert.equal(assess(root,'win32').code,'WINDOWS_JOB_RUNNER_NOT_VERIFIED');
    const bin=path.join(base,'tools/windows-job-runner/dist/win-x64/CommanderWindowsJobRunner.exe');
    const target=path.join(root,'tools/windows-job-runner/dist/win-x64/CommanderWindowsJobRunner.exe');
    const manifest=path.join(root,'tools/windows-job-runner/release-manifest.json');
    fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.writeFileSync(target,Buffer.from('fake native runner'));
    fs.mkdirSync(path.dirname(manifest),{recursive:true});
    fs.writeFileSync(manifest,JSON.stringify({runnerSha256:V102_ACCEPTED_WIN_JOB_SHA256}));
    assert.equal(assess(root,'win32').code,'WINDOWS_JOB_RUNNER_NOT_VERIFIED');
    if(fs.existsSync(bin)){
      fs.copyFileSync(bin,target);
      assert.equal(assess(root,'win32').status,'SOURCE_COVERAGE_PASS_NOT_G1_ACCEPTANCE');
    }
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('CLI rejects spoofed root, duplicate options and incomplete arguments',()=>{
  const root=fixture();
  const exe=path.join(base,'tools/v1-01/verify-g1-release-coverage.mjs');
  try{
    const opts=parseArgs(['--root='+root,'--minimum-version=0.11.0-dev.23','--target-platform=linux']);
    assert.equal(opts.root,root);
    for(const args of [
      [],['--root='+root,'--minimum-version=0.11.0-dev.23'],
      ['--root=relative','--minimum-version=0.11.0-dev.23','--target-platform=linux'],
      ['--root='+root,'--minimum-version=0.11.0-dev.23','--target-platform=macos'],
      ['--root='+root,'--minimum-version=0.11.0-dev.23','--root='+root]
    ])assert.throws(()=>parseArgs(args),/V101_BUNDLE/);
    const result=spawnSync(process.execPath,[exe,'--root='+root,
      '--minimum-version=0.11.0-dev.23','--target-platform=linux'],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    assert.equal(JSON.parse(result.stdout).productionG1Accepted,false);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('symlinked critical file cannot be passed as source coverage',()=>{
  const root=fixture();
  try{
    const f=path.join(root,'src/v2-oauth-jwks.mjs');
    const elsewhere=path.join(root,'source-target.mjs');
    fs.writeFileSync(elsewhere,'// external alias\n');
    fs.rmSync(f);
    try{fs.symlinkSync(elsewhere,f);}
    catch(error){
      if(['EPERM','EACCES','ENOTSUP'].includes(error.code))return;
      throw error;
    }
    assert.equal(assess(root).code,'G1_MODULES_OMITTED_FROM_RELEASE');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('J01 verifier integrity is required and cannot be replaced by a mock signer',()=>{
  const root=fixture();
  try{
    for(const relative of Object.keys(J01_VERIFIER_SHA256)){
      const original=fs.readFileSync(path.join(root,relative));
      fs.appendFileSync(path.join(root,relative),'\n// forged signer replacement\n');
      assert.equal(assess(root).code,'J01_VERIFIER_NOT_PINNED');
      fs.writeFileSync(path.join(root,relative),original);
    }
    assert.equal(assess(root).status,'SOURCE_COVERAGE_PASS_NOT_G1_ACCEPTANCE');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('V0.12 stable source admission rejects dev23 and pre-release variants',()=>{
  const root=fixture();
  try{
    for(const version of ['0.11.0-dev.23','0.11.0','0.12.0-dev.99']){
      fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version}));
      assert.notEqual(assessG1ReleaseBundle({
        root,platform:'linux',minimumVersion:'0.12.0'
      }).status,'SOURCE_COVERAGE_PASS_NOT_G1_ACCEPTANCE');
    }
    fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version:'0.12.0'}));
    const qualified=assessG1ReleaseBundle({root,platform:'linux',minimumVersion:'0.12.0'});
    assert.equal(qualified.status,'SOURCE_COVERAGE_PASS_NOT_G1_ACCEPTANCE');
    assert.equal(qualified.productionG1Accepted,false);
    assert.equal(qualified.j01CredentialEnrolled,false);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('G1 trust anchors cannot be missing, re-encoded or replaced in release source',()=>{
  const root=fixture();
  try{
    for(const relative of Object.keys(G1_TRUST_ASSETS_SHA256)){
      const file=path.join(root,relative);
      const original=fs.readFileSync(file);
      fs.rmSync(file);
      let verdict=assess(root);
      assert.equal(verdict.code,'G1_TRUST_ASSET_NOT_PINNED');
      assert.equal(verdict.asset,relative);
      fs.writeFileSync(file,Buffer.from(original.toString('utf8').replaceAll('\n','\r\n')));
      verdict=assess(root);
      assert.equal(verdict.code,'G1_TRUST_ASSET_NOT_PINNED');
      assert.equal(verdict.asset,relative);
      fs.writeFileSync(file,Buffer.from(original.toString('utf8').replace('CERTIFICATE','CERTIFICATX')));
      verdict=assess(root);
      assert.equal(verdict.code,'G1_TRUST_ASSET_NOT_PINNED');
      fs.writeFileSync(file,original);
      assert.equal(assess(root).status,'SOURCE_COVERAGE_PASS_NOT_G1_ACCEPTANCE');
    }
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
