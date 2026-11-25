import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cp, mkdir, mkdtemp, rm, writeFile, readFile, realpath } from 'node:fs/promises';
import { v102ActionDigest, v102PreparedPlanDigest } from '../src/execution-access-guard.mjs';
import { assessAccessStatus } from '../src/full-access-status.mjs';
import { probeWindowsAdministrator } from '../src/windows-admin-token.mjs';

const sourceProjectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = value => createHash('sha256').update(value).digest('hex');
const hostAccessConfig = {
  capabilityProfile: { tier: 'FULL_POWER', explicitlyAuthorized: true },
  powerMode: {
    enabled: true, fullFilesystem: true, allowShell: true,
    allowProcessControl: true, blockedShellPatterns: []
  }
};
const hostAdminToken = process.platform === 'win32'
  ? await probeWindowsAdministrator({ platform: process.platform })
  : null;
const hostAccessTier = assessAccessStatus(hostAccessConfig, null, {
  platform: process.platform,
  adminToken: hostAdminToken,
  effectiveUid: process.platform === 'linux' ? process.geteuid?.() : null
}).effectiveTier;
const canRunFullPowerWorker = hostAccessTier === 'FULL_POWER';
const fullPowerSkip = canRunFullPowerWorker ? false
  : `host effective tier is ${hostAccessTier}; positive FULL_POWER worker execution requires a non-elevated owner token`;

async function runWorker(spec, workerPath, workerProjectDir) {
  const child = spawn(process.execPath, [workerPath], {
    cwd: workerProjectDir, windowsHide: true, shell: false,
    stdio: ['pipe','ignore','pipe']
  });
  const stderr = [];
  child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
  const exited = once(child, 'exit');
  child.stdin.end(JSON.stringify(spec));
  const [code, signal] = await exited;
  return { code, signal, stderr: Buffer.concat(stderr).toString('utf8') };
}
async function fixture({ authorize = true } = {}) {
  const workerProjectDir = await mkdtemp(path.join(os.tmpdir(), 'rc-v102-worker-project-'));
  await cp(path.join(sourceProjectDir, 'src'), path.join(workerProjectDir, 'src'), { recursive: true });
  await mkdir(path.join(workerProjectDir, 'tools'), { recursive: true });
  const workerPath = path.join(workerProjectDir, 'tools', 'operation-worker.mjs');
  await cp(path.join(sourceProjectDir, 'tools', 'operation-worker.mjs'), workerPath);
  const createdRoot = await mkdtemp(path.join(os.tmpdir(), 'rc-v102-worker-'));
  // canonicalize before serializing the allowed root; Windows TEMP may be an 8.3 alias.
  const root = await realpath(createdRoot);
  const providerPath = path.join(workerProjectDir, 'src', 'worker-provider-' + randomUUID() + '.mjs');
  const providerSource = [
    'import { appendFile } from "node:fs/promises";',
    'export async function createWorkerExecutionAccess({ spec }) {',
    '  const ticket = spec.executionAuthorization;',
    '  return {',
    '    hostId: ticket.hostId,',
    '    leaseScope: \'machine-global\',',
    '    withLease: async (_key, work) => {',
    '      if (ticket.tracePath) await appendFile(ticket.tracePath, "lease-start\\n");',
    '      try { return await work(); } finally { if (ticket.tracePath) await appendFile(ticket.tracePath, "lease-end\\n"); }',
    '    },',
    '    authorizeExecution: async (context) => {',
    '      if (context.actionDigest !== ticket.actionDigest || context.planDigest !== ticket.planDigest) throw new Error("WORKER_TICKET_MISMATCH");',
    '      return { ...ticket, allowed: true, verified: true, tool: context.tool,',
    '        actionDigest: context.actionDigest, planDigest: context.planDigest, operationId: context.operationId };',
    '    }',
    '  };',
    '}'
  ].join('\n') + '\n';
  await writeFile(providerPath, providerSource, { encoding: 'utf8', mode: 0o600 });
  const providerSha256 = sha(providerSource);
  const config = {
    allowedRoots: [root],
    instance: { profile: 'profile-qa' },
    capabilityProfile: { id: 'profile-qa', tier: 'FULL_POWER', explicitlyAuthorized: true, disabledCapabilities: [] },
    powerMode: { enabled: true, fullFilesystem: true, allowShell: true, allowProcessControl: true, allowPermanentDelete: false, blockedShellPatterns: [] },
    executionAccess: { required: true, providerPath, providerSha256 }
  };
  const configRaw = JSON.stringify(config);
  const configPath = path.join(root, 'config.json');
  await writeFile(configPath, configRaw, { encoding: 'utf8', mode: 0o600 });
  const operationId = randomUUID();
  const requestId = 'request-' + randomUUID().replaceAll('-','');
  const marker = path.join(root, 'worker-effect.txt');
  const leaseTracePath = path.join(root, 'lease-trace.txt');
  const childScript = "const fs=require('node:fs');fs.writeFileSync(" + JSON.stringify(marker) + ",'spawned');setTimeout(()=>fs.appendFileSync(" + JSON.stringify(leaseTracePath) + ",'child-end\\n'),120)";
  const plan = {
    file: process.execPath,
    args: ['-e', childScript],
    cwd: root, timeoutMs: 10_000, outputLimit: 4096
  };
  const planDigest = v102PreparedPlanDigest('run_shell', plan);
  const ticket = authorize ? {
    actionDigest: sha('owner-approved-run-shell-action'),
    planDigest,
    hostId: 'host-qa', principalId: 'owner-qa', profileId: 'profile-qa',
    conversationId: 'chat-qa', operationId, nativeSessionId: 'session-qa',
    bindingId: 'a'.repeat(32), ownerScopeId: 'a'.repeat(64), effectiveTier: 'FULL_POWER', tracePath: leaseTracePath,
    capabilities: ['shell.execute','process.control'],
    grantRevision: 1, expiresAtMs: Date.now() + 20_000,
    nativePrivilegeVerified: false
  } : undefined;
  const inputHash = sha(JSON.stringify([requestId,operationId,planDigest]));
  const statePath = path.join(root, 'state.json');
  const resultPath = path.join(root, 'result.json');
  const stdoutPath = path.join(root, 'stdout.log');
  const stderrPath = path.join(root, 'stderr.log');
  const cancelPath = path.join(root, 'cancel');
  const prior = {
    schema: 1, operationId, requestId, inputHash, tool: 'run_shell',
    status: 'QUEUED', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), timeoutMs: 10_000,
    deadlineAt: new Date(Date.now() + 10_000).toISOString(),
    workerPid: null, childPid: null
  };
  await writeFile(statePath, JSON.stringify(prior), { encoding: 'utf8', mode: 0o600 });
  const spec = {
    kind: 'process', operationId, requestId, inputHash, tool: 'run_shell',
    ...plan, configPath, configSha256: sha(configRaw),
    ...(ticket ? { executionAuthorization: ticket } : {}),
    statePath, resultPath, stdoutPath, stderrPath, cancelPath
  };
  const dispose = async () => {
    await rm(providerPath, { force: true });
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 });
    await rm(workerProjectDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 });
  };
  return { root, marker, leaseTracePath, spec, workerPath, workerProjectDir, dispose };
}

test('detached operation worker authorizes exact plan before spawning a real child', { skip: fullPowerSkip }, async () => {
  const f = await fixture();
  try {
    const result = await runWorker(f.spec, f.workerPath, f.workerProjectDir);
    assert.equal(result.code, 0, result.stderr);
    const state = JSON.parse(await readFile(f.spec.statePath, 'utf8'));
    const receipt = JSON.parse(await readFile(f.spec.resultPath, 'utf8'));
    assert.equal(state.status, 'SUCCEEDED');
    assert.ok(state.childPid > 0);
    assert.equal(receipt.status, 'SUCCEEDED');
    assert.equal(await readFile(f.marker, 'utf8'), 'spawned');
    assert.deepEqual((await readFile(f.leaseTracePath, 'utf8')).trim().split(/\r?\n/), ['lease-start','child-end','lease-end']);
  } finally { await f.dispose(); }
});

test('power-tool worker uses the same owner gate before a real filesystem write', { skip: fullPowerSkip }, async () => {
  const f = await fixture();
  const args = { path: path.join(f.root, 'guarded-write.txt'), content: 'owner-approved' };
  try {
    f.spec.kind = 'power-tool';
    f.spec.tool = 'write_file';
    f.spec.toolArguments = args;
    f.spec.executionAuthorization.actionDigest = v102ActionDigest('write_file', args);
    f.spec.executionAuthorization.planDigest = null;
    const result = await runWorker(f.spec, f.workerPath, f.workerProjectDir);
    const state = JSON.parse(await readFile(f.spec.statePath, 'utf8'));
    assert.equal(result.code, 0, JSON.stringify({ stderr: result.stderr, state }));
    const receipt = JSON.parse(await readFile(f.spec.resultPath, 'utf8'));
    assert.equal(state.status, 'SUCCEEDED');
    assert.equal(receipt.status, 'SUCCEEDED');
    assert.equal(await readFile(args.path, 'utf8'), 'owner-approved');
  } finally { await f.dispose(); }
});

test('detached operation worker rejects a missing or malformed owner consent epoch before spawning', { skip: fullPowerSkip }, async () => {
  const f = await fixture();
  try {
    f.spec.executionAuthorization.bindingId = 'invalid-epoch';
    const result = await runWorker(f.spec, f.workerPath, f.workerProjectDir);
    assert.equal(result.code, 1);
    const state = JSON.parse(await readFile(f.spec.statePath, 'utf8'));
    assert.equal(state.status, 'UNCERTAIN');
    assert.equal(state.childPid, null);
    assert.match(state.error, /V102_AUTHORIZATION_BINDING_INVALID/);
    await assert.rejects(readFile(f.marker, 'utf8'), { code: 'ENOENT' });
  } finally { await f.dispose(); }
});

if (!canRunFullPowerWorker) {
  test('host without effective FULL_POWER rejects an otherwise valid owner ticket before spawning', async () => {
    const f = await fixture();
    try {
      const result = await runWorker(f.spec, f.workerPath, f.workerProjectDir);
      assert.equal(result.code, 1);
      const state = JSON.parse(await readFile(f.spec.statePath, 'utf8'));
      assert.equal(state.status, 'UNCERTAIN');
      assert.equal(state.childPid, null);
      assert.equal(state.error, 'V102_HOST_EFFECTIVE_TIER_REQUIRED');
      await assert.rejects(readFile(f.marker, 'utf8'), { code: 'ENOENT' });
    } finally { await f.dispose(); }
  });
}

test('power-tool worker does not write when required owner authorization is absent', async () => {
  const f = await fixture({ authorize: false });
  const args = { path: path.join(f.root, 'denied-write.txt'), content: 'must-not-write' };
  try {
    f.spec.kind = 'power-tool';
    f.spec.tool = 'write_file';
    f.spec.toolArguments = args;
    const result = await runWorker(f.spec, f.workerPath, f.workerProjectDir);
    assert.equal(result.code, 1);
    const state = JSON.parse(await readFile(f.spec.statePath, 'utf8'));
    assert.equal(state.status, 'UNCERTAIN');
    assert.match(state.error, /V102_WORKER_AUTHORIZATION_REQUIRED/);
    await assert.rejects(readFile(args.path, 'utf8'), { code: 'ENOENT' });
  } finally { await f.dispose(); }
});

test('detached operation worker does not spawn when required owner authorization is absent', async () => {
  const f = await fixture({ authorize: false });
  try {
    const result = await runWorker(f.spec, f.workerPath, f.workerProjectDir);
    assert.equal(result.code, 1);
    const state = JSON.parse(await readFile(f.spec.statePath, 'utf8'));
    assert.equal(state.status, 'UNCERTAIN');
    assert.equal(state.childPid, null);
    assert.match(state.error, /V102_WORKER_AUTHORIZATION_REQUIRED/);
    await assert.rejects(readFile(f.marker, 'utf8'), { code: 'ENOENT' });
  } finally { await f.dispose(); }
});
