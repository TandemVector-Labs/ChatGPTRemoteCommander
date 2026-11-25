#!/usr/bin/env node
// V1-02 read-only package gate. This proves payload identity, not owner consent,
// caller authentication, installation, activation, or signed delivery receipts.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';

export const V102_RUNTIME_FILES = Object.freeze([
  'src/execution-access-guard.mjs',
  'src/effective-power-mode.mjs',
  'src/power-tools-v0.3.mjs',
  'src/tools-v0.3.mjs',
  'tools/operation-worker.mjs'
]);
const NATIVE_RUNNER = 'tools/windows-job-runner/dist/win-x64/CommanderWindowsJobRunner.exe';
const MANIFEST = 'tools/windows-job-runner/release-manifest.json';
const RUNNER_SOURCE = 'tools/windows-job-runner/Program.cs';
const RUNNER_PROJECT = 'tools/windows-job-runner/CommanderWindowsJobRunner.csproj';
const RUNNER_VERIFIER = 'tools/windows-job-runner/verify-windows-job-runner.ps1';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const gitShow = (repo, commit, relative) => execFileSync('git', [
  '-C', repo, 'show', commit + ':' + relative
], { maxBuffer: 16 * 1024 * 1024, windowsHide: true, stdio: ['ignore','pipe','pipe'] });

async function candidateEntry(root, relative) {
  let target = root;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index++) {
    target = path.join(target, parts[index]);
    let stat;
    try { stat = await lstat(target); }
    catch (error) {
      if (error?.code === 'ENOENT') return { status: 'MISSING' };
      throw error;
    }
    if (stat.isSymbolicLink()) return { status: 'PATH_ALIAS_REJECTED' };
    if (index < parts.length - 1 && !stat.isDirectory()) {
      return { status: 'NON_DIRECTORY_PARENT' };
    }
    if (index === parts.length - 1) {
      if (!stat.isFile()) return { status: 'NOT_A_REGULAR_FILE' };
      return { status: 'FILE', bytes: await readFile(target) };
    }
  }
  return { status: 'MISSING' };
}

export async function inspectV102Payload({ sourceRepo, commit, candidateRoot, platform }) {
  if (!/^[a-f0-9]{40}$/.test(String(commit || ''))) throw new Error('V102_COMMIT_SHA_REQUIRED');
  if (!['win32','linux'].includes(platform)) throw new Error('V102_PLATFORM_UNSUPPORTED');
  if (!sourceRepo || !candidateRoot) throw new Error('V102_SOURCE_AND_CANDIDATE_REQUIRED');
  const [repo, root] = await Promise.all([realpath(sourceRepo),realpath(candidateRoot)]);
  const checks = [];
  const check = async (relative, expected) => {
    const entry = await candidateEntry(root, relative);
    const actualSha256 = entry.bytes ? sha(entry.bytes) : null;
    // Git stores the verifier's LF blob, while normal Windows checkouts may
    // materialize the same PowerShell text with CRLF. Restrict normalization
    // to this one text script; native executables and runtime JS stay byte exact.
    const normalizedSha256 = entry.bytes && relative === RUNNER_VERIFIER
      ? sha(Buffer.from(entry.bytes.toString('utf8').replace(/\r\n/g, '\n')))
      : null;
    const status = entry.status !== 'FILE' ? entry.status
      : actualSha256 === expected ? 'MATCH'
      : normalizedSha256 === expected ? 'MATCH_CRLF_EQUIVALENT'
      : 'HASH_MISMATCH';
    checks.push({
      file: relative, status, expectedSha256: expected, actualSha256,
      ...(status === 'MATCH_CRLF_EQUIVALENT' ? { normalization: 'CRLF_TO_LF' } : {})
    });
  };
  for (const relative of V102_RUNTIME_FILES) {
    await check(relative, sha(gitShow(repo, commit, relative)));
  }
  if (platform === 'win32') {
    const manifestBytes = gitShow(repo,commit,MANIFEST);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const sourceSha256 = sha(gitShow(repo,commit,RUNNER_SOURCE));
    const projectSha256 = sha(gitShow(repo,commit,RUNNER_PROJECT));
    if (manifest.schema !== 1 || manifest.platform !== 'win32' ||
        manifest.runner !== 'dist/win-x64/CommanderWindowsJobRunner.exe' ||
        !/^[a-f0-9]{64}$/.test(manifest.runnerSha256) ||
        manifest.sourceSha256 !== sourceSha256 ||
        manifest.projectSha256 !== projectSha256) {
      throw new Error('V102_NATIVE_RUNNER_MANIFEST_INVALID');
    }
    await check(MANIFEST,sha(manifestBytes));
    await check(RUNNER_SOURCE,sourceSha256);
    await check(RUNNER_PROJECT,projectSha256);
    await check(RUNNER_VERIFIER,sha(gitShow(repo,commit,RUNNER_VERIFIER)));
    await check(NATIVE_RUNNER,manifest.runnerSha256);
  }
  return {
    scope: 'SOURCE_PAYLOAD_IDENTITY_ONLY',
    sourceCommit: commit, platform,
    status: checks.every(v=>v.status === 'MATCH' || v.status === 'MATCH_CRLF_EQUIVALENT') ? 'PASS' : 'FAIL',
    checks
  };
}

function argsFromCli(argv) {
  const parsed = {};
  for (let i=0; i<argv.length; i+=2) {
    if (!['--source-repo','--commit','--candidate-root','--platform'].includes(argv[i]) ||
        i+1>=argv.length) throw new Error('V102_AUDIT_ARGUMENTS_INVALID');
    parsed[argv[i].slice(2).replaceAll('-','')] = argv[i+1];
  }
  return {
    sourceRepo: parsed.sourcerepo, candidateRoot: parsed.candidateroot,
    commit: parsed.commit, platform: parsed.platform
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  inspectV102Payload(argsFromCli(process.argv.slice(2)))
    .then(report => {
      process.stdout.write(JSON.stringify(report) + '\n');
      if (report.status !== 'PASS') process.exitCode = 2;
    })
    .catch(error => {
      process.stderr.write('V102_PAYLOAD_AUDIT_ERROR:' + String(error.message) + '\n');
      process.exitCode = 1;
    });
}
