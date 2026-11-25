import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { MutationIdempotencyStore } from '../src/mutation-idempotency.mjs';
import {
  executeV102AuthorizedOperation,
  executeV102WorkerProcess,
  loadV102WorkerExecutionAccess,
  v102ActionDigest,
  v102PreparedPlanDigest
} from '../src/execution-access-guard.mjs';

const now = () => Date.now();
const sha = value => createHash('sha256').update(value).digest('hex');

function accessStatus(configuredTier = 'FULL_POWER', effectiveTier = configuredTier) {
  const full = effectiveTier === 'FULL_ACCESS';
  const owner = effectiveTier === 'FULL_POWER';
  return {
    configuredTier, effectiveTier, operationalFullAccess: full,
    hostExecution: {mode:owner?'FULL_HOST_USER':'RESTRICTED',hostFilesystem:owner,shellAvailable:owner},
    nativeAdmin: {verified:full,nonElevatedTokenVerified:false},
    nativeRoot: {verified:full,nonRootTokenVerified:owner}
  };
}

function config(profileId = 'profile-qa', tier = 'FULL_POWER') {
  return {
    instance: { profile: profileId },
    capabilityProfile: {
      id: profileId, tier, explicitlyAuthorized: true,
      disabledCapabilities: []
    },
    powerMode: {
      enabled: true, fullFilesystem: true, allowShell: true,
      allowProcessControl: true, allowPermanentDelete: false,
      blockedShellPatterns: []
    },
    executionAccess: { required: true }
  };
}
function route(operationId = 'operation-qa-1') {
  return {
    hostId: 'host-qa', principalId: 'owner-qa', profileId: 'profile-qa',
    conversationId: 'chat-qa', operationId, nativeSessionId: 'session-qa',
    ownerScopeId: 'a'.repeat(64)
  };
}
function leaseProvider() {
  const tails = new Map();
  return async (key, work) => {
    const prior = tails.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const tail = prior.then(() => gate);
    tails.set(key, tail);
    await prior;
    try { return await work(); }
    finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}
async function fixture({ tool = 'run_shell', args = { command: 'printf ok', cwd: os.tmpdir() }, profileId = 'profile-qa' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rc-v102-exec-gate-'));
  const routeValue = route('operation-' + sha(root).slice(0, 16));
  const cfg = config(profileId);
  const receiptStore = new MutationIdempotencyStore({
    directory: path.join(root, 'receipts'),
    scope: 'v102:' + routeValue.hostId + ':' + routeValue.profileId
  });
  const state = {
    revision: 1, tier: 'FULL_POWER', session: 'session-qa', bindingId: 'a'.repeat(32),
    capabilities: ['shell.execute','process.control','process.terminate','terminal.persistent'],
    expiresAtMs: Date.now() + 20_000,
    calls: 0, changeOnExecution: null
  };
  const services = {
    hostId: routeValue.hostId,
    leaseScope: 'machine-global',
    withLease: leaseProvider(),
    receiptStore,
    authorizeExecution: async context => {
      state.calls++;
      if (context.phase === 'EXECUTION' && state.changeOnExecution) {
        const change = state.changeOnExecution;
        state.changeOnExecution = null;
        Object.assign(state, change);
      }
      const bound = routeValue;
      return {
        allowed: true, verified: true,
        tool: context.tool,
        actionDigest: context.actionDigest,
        planDigest: context.planDigest,
        hostId: bound.hostId, principalId: bound.principalId,
        profileId: profileId, conversationId: bound.conversationId,
        operationId: context.operationId, nativeSessionId: state.session, bindingId: state.bindingId,
        ownerScopeId: bound.ownerScopeId,
        effectiveTier: state.tier,
        capabilities: [...state.capabilities],
        grantRevision: state.revision,
        expiresAtMs: state.expiresAtMs,
        nativePrivilegeVerified: false
      };
    }
  };
  const authorization = { schema: 1, ticketId: 'owner-ticket-qa' };
  const requestId = 'request-' + sha(root).slice(0, 20);
  const dispose = async () => {
    receiptStore.close();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 });
  };
  const f = { root, route: routeValue, config: cfg, accessStatus:accessStatus('FULL_POWER'), services, authorization, requestId, tool, args, state, dispose };
  f.readAccessStatus = async () => f.accessStatus;
  return f;
}
async function run(f, overrides = {}) {
  return executeV102AuthorizedOperation({
    config: f.config, accessStatus:f.accessStatus, readAccessStatus:f.readAccessStatus, authorization: f.authorization, services: f.services,
    tool: f.tool, args: f.args, requestId: f.requestId,
    operationId: f.route.operationId,
    execute: overrides.execute ?? (async () => ({ started: true })),
    now: overrides.now ?? now
  });
}

test('action digest is stable across object-key order and changes with exact arguments', () => {
  assert.equal(v102ActionDigest('run_shell', { command: 'echo ok', cwd: '/tmp' }),
    v102ActionDigest('run_shell', { cwd: '/tmp', command: 'echo ok' }));
  assert.notEqual(v102ActionDigest('run_shell', { command: 'echo ok', cwd: '/tmp' }),
    v102ActionDigest('run_shell', { command: 'echo changed', cwd: '/tmp' }));
  assert.throws(() => v102ActionDigest('run_shell', { get command() { throw Error('getter'); } }),
    { code: 'V102_ACTION_ARGUMENTS_INVALID' });
});

test('valid owner-provider decision passes effective tier, native session, exact grant and receipt', async () => {
  const f = await fixture();
  let effects = 0;
  try {
    const result = await run(f, { execute: async () => ({ effect: ++effects }) });
    assert.deepEqual(result.result, { effect: 1 });
    assert.equal(result.authorization.effectiveTier, 'FULL_POWER');
    assert.equal(result.authorization.grantRevision, 1);
    assert.equal(result.authorization.bindingId, 'a'.repeat(32));
    assert.equal(result.authorization.ownerScopeId, f.route.ownerScopeId);
    assert.equal(effects, 1);
    assert.equal(f.state.calls, 2);
  } finally { await f.dispose(); }
});

test('STANDARD effective tier cannot dispatch a FULL_POWER process action', async () => {
  const f = await fixture();
  let effects = 0;
  try {
    f.state.tier = 'STANDARD';
    await assert.rejects(run(f, { execute: async () => { effects++; return { ok: true }; } }),
      { code: 'V102_EFFECTIVE_TIER_REQUIRED' });
    assert.equal(effects, 0);
  } finally { await f.dispose(); }
});

test('effective capability opt-out blocks an otherwise FULL_POWER action', async () => {
  const f = await fixture();
  let effects = 0;
  try {
    f.state.capabilities = ['process.control'];
    await assert.rejects(run(f, { execute: async () => { effects++; return { ok: true }; } }),
      { code: 'V102_EFFECTIVE_CAPABILITY_REQUIRED' });
    assert.equal(effects, 0);
  } finally { await f.dispose(); }
});

test('effective-tier downgrade between admission and execution blocks the effect', async () => {
  const f = await fixture();
  let effects = 0;
  try {
    f.state.changeOnExecution = { tier: 'STANDARD' };
    await assert.rejects(run(f, { execute: async () => { effects++; return { ok: true }; } }),
      { code: 'V102_EFFECTIVE_TIER_REQUIRED' });
    assert.equal(effects, 0);
  } finally { await f.dispose(); }
});

test('owner native-session switch between admission and execution blocks the effect', async () => {
  const f = await fixture();
  let effects = 0;
  try {
    f.state.changeOnExecution = { session: 'session-other' };
    await assert.rejects(run(f, { execute: async () => { effects++; return { ok: true }; } }),
      { code: 'V102_AUTHORIZATION_CHANGED_BEFORE_EFFECT' });
    assert.equal(effects, 0);
  } finally { await f.dispose(); }
});

test('grant revoke/regrant revision between admission and execution cannot revive a queued action', async () => {
  const f = await fixture();
  let effects = 0;
  try {
    f.state.changeOnExecution = { revision: 3 };
    await assert.rejects(run(f, { execute: async () => { effects++; return { ok: true }; } }),
      { code: 'V102_AUTHORIZATION_CHANGED_BEFORE_EFFECT' });
    assert.equal(effects, 0);
  } finally { await f.dispose(); }
});

test('owner consent regrant rotates binding epoch and blocks a queued action', async () => {
  const f = await fixture();
  let effects = 0;
  try {
    f.state.changeOnExecution = { bindingId: 'b'.repeat(32) };
    await assert.rejects(run(f, { execute: async () => { effects++; return { ok: true }; } }),
      { code: 'V102_AUTHORIZATION_CHANGED_BEFORE_EFFECT' });
    assert.equal(effects, 0);
  } finally { await f.dispose(); }
});

test('missing or malformed owner consent binding epoch fails closed', async () => {
  const f = await fixture();
  let effects = 0;
  try {
    f.state.bindingId = 'not-a-random-consent-epoch';
    await assert.rejects(run(f, { execute: async () => { effects++; return { ok: true }; } }),
      { code: 'V102_AUTHORIZATION_BINDING_INVALID' });
    assert.equal(effects, 0);
  } finally { await f.dispose(); }
});

test('wrong host, profile, or conversation is rejected before the effect', async () => {
  const f = await fixture();
  let effects = 0;
  try {
    const original = f.services.authorizeExecution;
    f.services.authorizeExecution = async context => ({ ...(await original(context)), profileId: 'other-profile' });
    await assert.rejects(run(f, { execute: async () => { effects++; return { ok: true }; } }),
      { code: 'V102_AUTHORIZATION_SCOPE_MISMATCH' });
    assert.equal(effects, 0);
  } finally { await f.dispose(); }
});

test('changed action arguments do not match the owner-signed digest', async () => {
  const f = await fixture();
  let effects = 0;
  try {
    const approved = v102ActionDigest(f.tool, f.args);
    const original = f.services.authorizeExecution;
    f.services.authorizeExecution = async context => ({
      ...(await original(context)), actionDigest: approved
    });
    const changed = { ...f.args, command: 'printf changed' };
    await assert.rejects(executeV102AuthorizedOperation({
      config: f.config, accessStatus:f.accessStatus, readAccessStatus:f.readAccessStatus, authorization: f.authorization, services: f.services,
      tool: f.tool, args: changed, requestId: f.requestId,
      operationId: f.route.operationId,
      execute: async () => { effects++; return { ok: true }; }
    }), { code: 'V102_AUTHORIZATION_DENIED_OR_ACTION_MISMATCH' });
    assert.equal(effects, 0);
  } finally { await f.dispose(); }
});

test('explicit caller-supplied digest must match actual arguments before owner-provider admission', async () => {
  const f = await fixture();
  let effects = 0;
  let authorizationCalls = 0;
  try {
    const original = f.services.authorizeExecution;
    f.services.authorizeExecution = async context => {
      authorizationCalls += 1;
      return original(context);
    };
    const preapprovedDigest = v102ActionDigest(f.tool, f.args);
    await assert.rejects(executeV102AuthorizedOperation({
      config: f.config, accessStatus:f.accessStatus, readAccessStatus:f.readAccessStatus, authorization: f.authorization, services: f.services,
      tool: f.tool, args: { ...f.args, command: 'printf altered' },
      actionDigest: preapprovedDigest, requestId: f.requestId,
      operationId: f.route.operationId,
      execute: async () => { effects += 1; return { ok: true }; }
    }), { code: 'V102_ACTION_DIGEST_ARGUMENTS_MISMATCH' });
    assert.equal(authorizationCalls, 0);
    assert.equal(effects, 0);
  } finally { await f.dispose(); }
});

test('nested action arguments cannot change after owner admission before effect', async () => {
  const args = { command: 'printf authorized', options: { flags: ['owner'] } };
  const f = await fixture({ tool: 'run_shell', args });
  const original = f.services.authorizeExecution;
  let writes = null;
  try {
    f.services.authorizeExecution = async context => {
      if (context.phase === 'ADMISSION') {
        writes = [
          Reflect.set(args, 'command', 'printf forged'),
          Reflect.set(args.options, 'other', true),
          Reflect.set(args.options.flags, 0, 'forged')
        ];
      }
      return original(context);
    };
    const outcome = await executeV102AuthorizedOperation({
      config: f.config, accessStatus:f.accessStatus, readAccessStatus:f.readAccessStatus, authorization: f.authorization, services: f.services,
      tool: 'run_shell', args, requestId: f.requestId,
      operationId: f.route.operationId,
      execute: async () => ({
        command: args.command,
        flags: [...args.options.flags],
        hasInjectedOption: Object.hasOwn(args.options, 'other')
      })
    });
    assert.deepEqual(writes, [false, false, false]);
    assert.deepEqual(outcome.result, {
      command: 'printf authorized', flags: ['owner'], hasInjectedOption: false
    });
    assert.equal(Object.isFrozen(args), true);
    assert.equal(Object.isFrozen(args.options), true);
    assert.equal(Object.isFrozen(args.options.flags), true);
  } finally { await f.dispose(); }
});

test('direct operation cannot omit both actual arguments and an exact process-plan digest', async () => {
  const f = await fixture();
  let effects = 0;
  let authorizationCalls = 0;
  try {
    const original = f.services.authorizeExecution;
    f.services.authorizeExecution = async context => {
      authorizationCalls += 1;
      return original(context);
    };
    await assert.rejects(executeV102AuthorizedOperation({
      config: f.config, accessStatus:f.accessStatus, readAccessStatus:f.readAccessStatus, authorization: f.authorization, services: f.services,
      tool: f.tool, actionDigest: v102ActionDigest(f.tool, f.args),
      requestId: f.requestId, operationId: f.route.operationId,
      execute: async () => { effects += 1; return { effect: effects }; }
    }), { code: 'V102_ACTION_ARGUMENTS_REQUIRED' });
    assert.equal(effects, 0);
    assert.equal(authorizationCalls, 0);
  } finally { await f.dispose(); }
});

test('matching explicit digest and null fallback preserve authorized execution', async () => {
  for (const mode of ['explicit', 'null']) {
    const f = await fixture();
    let effects = 0;
    try {
      const digest = mode === 'explicit' ? v102ActionDigest(f.tool, f.args) : null;
      const outcome = await executeV102AuthorizedOperation({
        config: f.config, accessStatus:f.accessStatus, readAccessStatus:f.readAccessStatus, authorization: f.authorization, services: f.services,
        tool: f.tool, args: f.args, actionDigest: digest,
        requestId: f.requestId, operationId: f.route.operationId,
        execute: async () => ({ effect: ++effects })
      });
      assert.deepEqual(outcome.result, { effect: 1 });
      assert.equal(effects, 1);
    } finally { await f.dispose(); }
  }
});

test('expired and overlong owner decisions fail closed', async () => {
  const f = await fixture();
  let effects = 0;
  try {
    f.state.expiresAtMs = Date.now() - 1;
    await assert.rejects(run(f, { execute: async () => { effects++; return { ok: true }; } }),
      { code: 'V102_AUTHORIZATION_CLAIMS_INVALID' });
    f.state.expiresAtMs = Date.now() + 120_000;
    await assert.rejects(run(f, { execute: async () => { effects++; return { ok: true }; } }),
      { code: 'V102_AUTHORIZATION_CLAIMS_INVALID' });
    assert.equal(effects, 0);
  } finally { await f.dispose(); }
});

test('FULL_ACCESS-only privileged service start requires native privilege proof', async () => {
  const f = await fixture({ tool: 'privileged_system_unit_start', args: {} });
  let effects = 0;
  try {
    f.config.capabilityProfile.tier = 'FULL_ACCESS';
    f.accessStatus = accessStatus('FULL_ACCESS');
    f.state.tier = 'FULL_ACCESS';
    await assert.rejects(run(f, { execute: async () => { effects++; return { ok: true }; } }),
      { code: 'V102_NATIVE_PRIVILEGE_PROOF_REQUIRED' });
    assert.equal(effects, 0);
  } finally { await f.dispose(); }
});

test('a FULL_POWER host cannot authorize a FULL_ACCESS-only effect even if a provider would claim elevation', async () => {
  const f = await fixture({ tool: 'privileged_system_unit_start', args: {} });
  let effects = 0;
  try {
    // The signed owner decision cannot override the separately configured tier ceiling.
    assert.equal(f.config.capabilityProfile.tier, 'FULL_POWER');
    f.state.tier = 'FULL_ACCESS';
    const underlying = f.services.authorizeExecution;
    f.services.authorizeExecution = async context => ({
      ...await underlying(context),
      nativePrivilegeVerified: true
    });
    await assert.rejects(
      run(f, { execute: async () => { effects++; return { ok: true }; } }),
      { code: 'V102_HOST_EFFECTIVE_TIER_REQUIRED' }
    );
    assert.equal(f.state.calls, 0);
    assert.equal(effects, 0);
  } finally { await f.dispose(); }
});

test('configured FULL_POWER rejects an owner decision above its configured tier ceiling', async () => {
  const f = await fixture({ tool: 'run_shell', args: {command:'printf ok',cwd:os.tmpdir()} });
  let effects = 0;
  try {
    f.state.tier = 'FULL_ACCESS';
    const underlying = f.services.authorizeExecution;
    f.services.authorizeExecution = async context => ({
      ...await underlying(context),
      nativePrivilegeVerified: true
    });
    await assert.rejects(
      run(f, { execute: async () => { effects++; return { ok: true }; } }),
      { code: 'V102_EFFECTIVE_TIER_EXCEEDS_CONFIGURED_TIER' }
    );
    assert.equal(effects, 0);
  } finally { await f.dispose(); }
});

test('host effective tier is re-read and a downgrade between admission and effect blocks execution', async () => {
  const f = await fixture();
  let reads = 0;
  let effects = 0;
  try {
    f.readAccessStatus = async () => {
      reads++;
      return reads === 1 ? accessStatus('FULL_POWER') : accessStatus('FULL_POWER','STANDARD');
    };
    await assert.rejects(
      run(f, { execute: async () => { effects++; return { ok: true }; } }),
      { code: 'V102_HOST_EFFECTIVE_TIER_CHANGED_BEFORE_EFFECT' }
    );
    assert.equal(reads, 2);
    assert.equal(f.state.calls, 1);
    assert.equal(effects, 0);
  } finally { await f.dispose(); }
});

test('host effective tier is rechecked after owner authorization immediately before the side effect', async () => {
  const f = await fixture();
  let reads = 0;
  let effects = 0;
  try {
    f.readAccessStatus = async () => {
      reads++;
      return reads < 3 ? accessStatus('FULL_POWER') : accessStatus('FULL_POWER','STANDARD');
    };
    await assert.rejects(
      run(f, { execute: async () => { effects++; return { ok: true }; } }),
      { code: 'V102_HOST_EFFECTIVE_TIER_CHANGED_BEFORE_EFFECT' }
    );
    assert.equal(reads, 3);
    assert.equal(f.state.calls, 2);
    assert.equal(effects, 0);
  } finally { await f.dispose(); }
});

test('configured FULL_ACCESS cannot run FULL_ACCESS-only effects while this worker is only FULL_POWER', async () => {
  const f = await fixture({ tool: 'privileged_system_unit_start', args: {} });
  let effects = 0;
  try {
    f.config.capabilityProfile.tier = 'FULL_ACCESS';
    f.accessStatus = accessStatus('FULL_ACCESS','FULL_POWER');
    f.state.tier = 'FULL_ACCESS';
    await assert.rejects(
      run(f, { execute: async () => { effects++; return { ok: true }; } }),
      { code: 'V102_HOST_EFFECTIVE_TIER_REQUIRED' }
    );
    assert.equal(f.state.calls, 0);
    assert.equal(effects, 0);
  } finally { await f.dispose(); }
});

test('same request is at-most-once and changed arguments conflict in the durable receipt store', async () => {
  const f = await fixture();
  let effects = 0;
  try {
    const first = await run(f, { execute: async () => ({ effect: ++effects }) });
    const retry = await run(f, { execute: async () => ({ effect: ++effects }) });
    assert.deepEqual(retry.result, first.result);
    assert.equal(effects, 1);
    const changedArgs = { ...f.args, command: 'printf different' };
    await assert.rejects(executeV102AuthorizedOperation({
      config: f.config, accessStatus:f.accessStatus, readAccessStatus:f.readAccessStatus, authorization: f.authorization, services: f.services,
      tool: f.tool, args: changedArgs, requestId: f.requestId,
      operationId: f.route.operationId,
      execute: async () => { effects++; return { effect: effects }; }
    }), /MUTATION_REQUEST_ID_CONFLICT/);
    assert.equal(effects, 1);
  } finally { await f.dispose(); }
});

test('a new owner consent epoch cannot reuse a prior durable receipt under the same requestId', async () => {
  const f = await fixture();
  let effects = 0;
  try {
    const first = await run(f, { execute: async () => ({ effect: ++effects }) });
    assert.equal(first.result.effect, 1);
    f.state.bindingId = 'b'.repeat(32);
    await assert.rejects(run(f, { execute: async () => ({ effect: ++effects }) }),
      /MUTATION_REQUEST_ID_CONFLICT/);
    assert.equal(effects, 1);
  } finally { await f.dispose(); }
});

test('a new native owner session cannot replay an older operation receipt', async () => {
  const f = await fixture();
  let effects = 0;
  try {
    await run(f, { execute: async () => ({ effect: ++effects }) });
    f.state.session = 'session-relogged-qa';
    await assert.rejects(run(f, { execute: async () => ({ effect: ++effects }) }),
      /MUTATION_REQUEST_ID_CONFLICT/);
    assert.equal(effects, 1);
  } finally { await f.dispose(); }
});

test('concurrent duplicate dispatches serialize and start one effect', async () => {
  const f = await fixture();
  let effects = 0;
  try {
    const [a,b] = await Promise.all([
      run(f, { execute: async () => ({ effect: ++effects }) }),
      run(f, { execute: async () => ({ effect: ++effects }) })
    ]);
    assert.deepEqual(a.result, b.result);
    assert.equal(effects, 1);
  } finally { await f.dispose(); }
});

test('durable worker adapter gates process spawn and verifies the prepared plan digest', async () => {
  const f = await fixture();
  const plan = {
    file: process.execPath, args: ['-e', 'setTimeout(()=>{},25)'],
    cwd: f.root, timeoutMs: 1000, outputLimit: 4096
  };
  const planDigest = v102PreparedPlanDigest('run_shell', plan);
  const spec = {
    kind: 'process', operationId: f.route.operationId, requestId: f.requestId,
    tool: 'run_shell', ...plan,
    executionAuthorization: {
      actionDigest: 'b'.repeat(64), planDigest
    }
  };
  let starts = 0;
  try {
    const result = await executeV102WorkerProcess({
      config: f.config, accessStatus:f.accessStatus, readAccessStatus:f.readAccessStatus, spec, services: f.services,
      startProcess: () => { starts++; return spawn(process.execPath, plan.args, { cwd: f.root, windowsHide: true, stdio: 'ignore' }); }
    });
    assert.ok(result.child.pid > 0);
    const [code] = await once(result.child, 'exit');
    assert.equal(code, 0);
    assert.equal(starts, 1);
  } finally { await f.dispose(); }
});

test('non-process action cannot borrow the detached process plan lane', async () => {
  const f = await fixture({ tool: 'write_file', args: { path: 'synthetic', content: 'synthetic' } });
  const plan = {
    file: process.execPath, args: ['--version'], cwd: f.root,
    timeoutMs: 1000, outputLimit: 4096
  };
  let effects = 0;
  let ownerCalls = 0;
  const original = f.services.authorizeExecution;
  f.services.authorizeExecution = async context => {
    ownerCalls += 1;
    return original(context);
  };
  try {
    assert.throws(() => v102PreparedPlanDigest('write_file', plan), {
      code: 'V102_PROCESS_TOOL_REQUIRED'
    });
    await assert.rejects(executeV102AuthorizedOperation({
      config: f.config, accessStatus:f.accessStatus, readAccessStatus:f.readAccessStatus, authorization: f.authorization, services: f.services,
      tool: 'write_file', actionDigest: 'b'.repeat(64), planDigest: 'c'.repeat(64),
      operationId: f.route.operationId, requestId: f.requestId,
      execute: async () => { effects += 1; return { effect: effects }; }
    }), { code: 'V102_PROCESS_TOOL_REQUIRED' });
    await assert.rejects(executeV102WorkerProcess({
      config: f.config, accessStatus:f.accessStatus, readAccessStatus:f.readAccessStatus, spec: {
        kind: 'process', tool: 'write_file', ...plan,
        operationId: f.route.operationId, requestId: f.requestId,
        executionAuthorization: {
          actionDigest: 'b'.repeat(64), planDigest: 'c'.repeat(64)
        }
      }, services: f.services, startProcess: () => { effects += 1; return { pid: 4242 }; }
    }), { code: 'V102_PROCESS_TOOL_REQUIRED' });
    assert.equal(ownerCalls, 0);
    assert.equal(effects, 0);
  } finally { await f.dispose(); }
});

test('worker rejects a process plan altered after authorization', async () => {
  const f = await fixture();
  const plan = { file: process.execPath, args: ['-e', 'process.exit(0)'], cwd: f.root, timeoutMs: 1000, outputLimit: 4096 };
  const spec = {
    kind: 'process', operationId: f.route.operationId, requestId: f.requestId,
    tool: 'run_shell', ...plan,
    executionAuthorization: { actionDigest: 'b'.repeat(64), planDigest: 'c'.repeat(64) }
  };
  let starts = 0;
  try {
    await assert.rejects(executeV102WorkerProcess({
      config: f.config, accessStatus:f.accessStatus, readAccessStatus:f.readAccessStatus, spec, services: f.services,
      startProcess: () => { starts++; return { pid: 4242 }; }
    }), { code: 'V102_WORKER_PLAN_AUTHORIZATION_MISMATCH' });
    assert.equal(starts, 0);
  } finally { await f.dispose(); }
});

test('worker loader requires a pinned V1-01 provider when execution access is required', async () => {
  await assert.rejects(loadV102WorkerExecutionAccess({
    config: { executionAccess: { required: true } }, spec: {}, projectDir: process.cwd()
  }), { code: 'V102_WORKER_AUTHORIZATION_REQUIRED' });
});

test('worker loader accepts only a hash-pinned provider inside src', async () => {
  const f = await fixture();
  const src = path.join(f.root, 'src');
  await mkdir(src, { recursive: true });
  const providerPath = path.join(src, 'provider.mjs');
  const providerSource = [
    "export async function createWorkerExecutionAccess({ spec }) {",
    "  const d = spec.executionAuthorization;",
    "  return {",
    "    hostId: d.hostId,",
    "    leaseScope: 'machine-global',",
    "    withLease: async (_key, work) => work(),",
    "    authorizeExecution: async (context) => ({",
    "      ...d, allowed: true, verified: true,",
    "      tool: context.tool, actionDigest: context.actionDigest,",
    "      planDigest: context.planDigest, operationId: context.operationId",
    "    })",
    "  };",
    "}"
  ].join('\n') + '\n';
  try {
    await writeFile(providerPath, providerSource, { encoding: 'utf8', mode: 0o600 });
    const providerHash = sha(providerSource);
    const cfg = {
      ...f.config,
      executionAccess: { required: true, providerPath, providerSha256: providerHash }
    };
    const decision = {
      actionDigest: v102ActionDigest('write_file', { path: path.join(f.root, 'x'), content: 'x' }),
      planDigest: null, hostId: f.route.hostId, principalId: f.route.principalId,
      profileId: f.route.profileId, conversationId: f.route.conversationId,
      operationId: f.route.operationId, nativeSessionId: 'session-qa', bindingId: 'a'.repeat(32),
      ownerScopeId: f.route.ownerScopeId, effectiveTier: 'FULL_POWER',
      capabilities: [], grantRevision: 1, expiresAtMs: Date.now() + 10_000
    };
    const spec = { requestId: f.requestId, operationId: f.route.operationId, executionAuthorization: decision };
    const loaded = await loadV102WorkerExecutionAccess({ config: cfg, spec, projectDir: f.root, accessStatus:f.accessStatus, readAccessStatus:f.readAccessStatus });
    assert.equal(typeof loaded.executionAccess.run, 'function');
    const args = { path: path.join(f.root, 'x'), content: 'x' };
    const output = await loaded.executionAccess.run({
      tool: 'write_file', args, requestId: f.requestId, operationId: f.route.operationId
    }, async () => ({ accepted: true }));
    assert.deepEqual(output.result, { accepted: true });
    await writeFile(providerPath, providerSource + '// altered\n', { encoding: 'utf8', mode: 0o600 });
    await assert.rejects(loadV102WorkerExecutionAccess({ config: cfg, spec, projectDir: f.root, accessStatus:f.accessStatus, readAccessStatus:f.readAccessStatus }),
      { code: 'V102_WORKER_PROVIDER_HASH_MISMATCH' });
  } finally { await f.dispose(); }
});

test('power-tool mutation fails closed when execution access is required but not wired', async () => {
  const { executePowerTool } = await import('../src/power-tools-v0.3.mjs');
  const f = await fixture({ tool: 'write_file', args: { path: path.join(os.tmpdir(), 'v102-deny-write.txt'), content: 'blocked' } });
  try {
    await assert.rejects(executePowerTool({
      config: f.config,
      accessStatus:f.accessStatus,
      roots: [os.tmpdir()],
      auditLog: path.join(f.root, 'audit.jsonl')
    }, 'write_file', f.args), /V102_EXECUTION_ACCESS_REQUIRED/);
  } finally { await f.dispose(); }
});
