import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, copyFile, rm, unlink } from 'node:fs/promises';
import { inspectV102Payload, V102_RUNTIME_FILES } from '../tools/v102-payload-audit.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
const nativeRunner = 'tools/windows-job-runner/dist/win-x64/CommanderWindowsJobRunner.exe';
const manifest = 'tools/windows-job-runner/release-manifest.json';
const runnerSource = 'tools/windows-job-runner/Program.cs';
const runnerProject = 'tools/windows-job-runner/CommanderWindowsJobRunner.csproj';
const runnerVerifier = 'tools/windows-job-runner/verify-windows-job-runner.ps1';
const git = (repo, args) => execFileSync('git',['-C',repo,...args],{
  windowsHide:true,stdio:['ignore','pipe','pipe']
}).toString('utf8').trim();

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(),'v102-payload-test-'));
  t.after(async()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50}));
  const repo=path.join(root,'source'), candidate=path.join(root,'candidate');
  await mkdir(repo,{recursive:true});
  await mkdir(candidate,{recursive:true});
  const bytes={};
  for (const file of V102_RUNTIME_FILES) bytes[file]=Buffer.from('fixture:' + file + '\n');
  bytes[nativeRunner]=Buffer.from('fake-native-runner-fixture-not-executable');
  bytes[runnerSource]=Buffer.from('synthetic-native-runner-source');
  bytes[runnerProject]=Buffer.from('synthetic-native-runner-project');
  bytes[runnerVerifier]=Buffer.from('Write-Output verify\nWrite-Output pass\n');
  bytes[manifest]=Buffer.from(JSON.stringify({
    schema:1,platform:'win32',runner:'dist/win-x64/CommanderWindowsJobRunner.exe',
    runnerSha256:hash(bytes[nativeRunner]),
    sourceSha256:hash(bytes[runnerSource]),projectSha256:hash(bytes[runnerProject])
  }));
  for (const [rel,data] of Object.entries(bytes)) {
    for(const targetRoot of [repo,candidate]) {
      const destination=path.join(targetRoot,...rel.split('/'));
      await mkdir(path.dirname(destination),{recursive:true});
      await writeFile(destination,data);
    }
  }
  git(repo,['init','-q']);
  git(repo,['add','.']);
  git(repo,['-c','user.email=qa@invalid.local','-c','user.name=QA',
    'commit','-q','-m','fixture']);
  return {repo,candidate,commit:git(repo,['rev-parse','HEAD'])};
}

test('Linux payload accepts exact five V1-02 runtime dependencies from pinned source commit',async t=>{
  const f=await fixture(t);
  const report=await inspectV102Payload({
    sourceRepo:f.repo,commit:f.commit,candidateRoot:f.candidate,platform:'linux'
  });
  assert.equal(report.status,'PASS');
  assert.equal(report.checks.length,5);
  assert.ok(report.checks.every(c=>c.status==='MATCH'));
});

test('Windows payload requires pinned native job runner as well as runtime files',async t=>{
  const f=await fixture(t);
  const report=await inspectV102Payload({
    sourceRepo:f.repo,commit:f.commit,candidateRoot:f.candidate,platform:'win32'
  });
  assert.equal(report.status,'PASS');
  assert.equal(report.checks.length,10);
});

test('missing effective Power Mode dependency denies otherwise complete Linux payload',async t=>{
  const f=await fixture(t);
  await unlink(path.join(f.candidate,'src','effective-power-mode.mjs'));
  const report=await inspectV102Payload({
    sourceRepo:f.repo,commit:f.commit,candidateRoot:f.candidate,platform:'linux'
  });
  assert.equal(report.status,'FAIL');
  assert.deepEqual(report.checks.filter(c=>c.status==='MISSING').map(c=>c.file),
    ['src/effective-power-mode.mjs']);
});

test('packaged altered runtime bytes fail payload identity without side effects',async t=>{
  const f=await fixture(t);
  await writeFile(path.join(f.candidate,'src','tools-v0.3.mjs'),'modified');
  const report=await inspectV102Payload({
    sourceRepo:f.repo,commit:f.commit,candidateRoot:f.candidate,platform:'linux'
  });
  assert.equal(report.status,'FAIL');
  assert.deepEqual(report.checks.filter(c=>c.status!=='MATCH').map(c=>c.file),
    ['src/tools-v0.3.mjs']);
});

test('missing module and missing native runner each fail closed',async t=>{
  const f=await fixture(t);
  await unlink(path.join(f.candidate,'src','execution-access-guard.mjs'));
  await unlink(path.join(f.candidate,...nativeRunner.split('/')));
  const report=await inspectV102Payload({
    sourceRepo:f.repo,commit:f.commit,candidateRoot:f.candidate,platform:'win32'
  });
  assert.equal(report.status,'FAIL');
  assert.deepEqual(report.checks.filter(c=>c.status==='MISSING').map(c=>c.file),
    ['src/execution-access-guard.mjs',nativeRunner]);
});

test('Windows CRLF-only verifier checkout is explicitly accepted as normalized source',async t=>{
  const f=await fixture(t);
  await writeFile(path.join(f.candidate,...runnerVerifier.split('/')),
    'Write-Output verify\\r\\nWrite-Output pass\\r\\n'.replaceAll('\\r','\r').replaceAll('\\n','\n'));
  const report=await inspectV102Payload({
    sourceRepo:f.repo,commit:f.commit,candidateRoot:f.candidate,platform:'win32'
  });
  assert.equal(report.status,'PASS');
  const verifier = report.checks.find(c=>c.file === runnerVerifier);
  assert.equal(verifier.status,'MATCH_CRLF_EQUIVALENT');
  assert.equal(verifier.normalization,'CRLF_TO_LF');
  assert.notEqual(verifier.actualSha256,verifier.expectedSha256);
});

test('changed native verifier is rejected even with matching executable hash',async t=>{
  const f=await fixture(t);
  await writeFile(path.join(f.candidate,...runnerVerifier.split('/')),'modified verifier');
  const report=await inspectV102Payload({
    sourceRepo:f.repo,commit:f.commit,candidateRoot:f.candidate,platform:'win32'
  });
  assert.equal(report.status,'FAIL');
  assert.deepEqual(report.checks.filter(c=>c.status==='HASH_MISMATCH').map(c=>c.file),
    [runnerVerifier]);
});

test('invalid commit and unsupported target OS are rejected before any file comparison',async t=>{
  const f=await fixture(t);
  await assert.rejects(inspectV102Payload({
    sourceRepo:f.repo,commit:'HEAD',candidateRoot:f.candidate,platform:'linux'
  }),/V102_COMMIT_SHA_REQUIRED/);
  await assert.rejects(inspectV102Payload({
    sourceRepo:f.repo,commit:f.commit,candidateRoot:f.candidate,platform:'darwin'
  }),/V102_PLATFORM_UNSUPPORTED/);
});
