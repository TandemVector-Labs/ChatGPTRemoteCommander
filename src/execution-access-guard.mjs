// V1-02 execution gate. Identity and consent remain V1-01 responsibilities;
// durable operation receipts remain V1-06 responsibilities. This module consumes
// their trusted host-side provider and never manufactures owner authority.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_TICKET_MS = 30_000;
const PROCESS_PLAN_TOOLS = new Set(['run_shell', 'run_project_command']);
const TIER_RANK = Object.freeze({ STANDARD: 0, FULL_POWER: 1, FULL_ACCESS: 2 });
const ACTION_POLICY = Object.freeze({
  write_file: { minimumTier: 'FULL_POWER', capabilities: [], flags: ['enabled'] },
  create_directory: { minimumTier: 'FULL_POWER', capabilities: [], flags: ['enabled'] },
  copy_path: { minimumTier: 'FULL_POWER', capabilities: [], flags: ['enabled'] },
  move_path: { minimumTier: 'FULL_POWER', capabilities: [], flags: ['enabled'] },
  delete_path: { minimumTier: 'FULL_POWER', capabilities: [], flags: ['enabled'] },
  run_project_command: { minimumTier: 'FULL_POWER', capabilities: ['process.control'], flags: ['enabled','allowProcessControl'] },
  run_shell: { minimumTier: 'FULL_POWER', capabilities: ['shell.execute', 'process.control'], flags: ['enabled','allowShell','allowProcessControl'] },
  kill_process: { minimumTier: 'FULL_POWER', capabilities: ['process.control','process.terminate'], flags: ['enabled','allowProcessControl'] },
  start_terminal: { minimumTier: 'FULL_POWER', capabilities: ['terminal.persistent','shell.execute','process.control'], flags: ['enabled','allowShell','allowProcessControl'] },
  send_terminal: { minimumTier: 'FULL_POWER', capabilities: ['terminal.persistent','shell.execute','process.control'], flags: ['enabled','allowShell','allowProcessControl'] },
  stop_terminal: { minimumTier: 'FULL_POWER', capabilities: ['process.control','process.terminate'], flags: ['enabled','allowProcessControl'] },
  privileged_system_unit_start: { minimumTier: 'FULL_ACCESS', capabilities: [], flags: ['enabled'], nativePrivilege: true }
});

function fail(code) { throw Object.assign(new Error(code), { code }); }
function safe(value) { return typeof value === 'string' && ID.test(value) && value !== '.' && value !== '..'; }
function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function dataObject(value, code) {
  if (!plain(value)) fail(code);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || ['__proto__','constructor','prototype'].includes(key)) fail(code);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
  }
}
function canonical(value, seen = new WeakSet(), depth = 0) {
  if (depth > 24) fail('V102_ACTION_ARGUMENTS_INVALID');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('V102_ACTION_ARGUMENTS_INVALID');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object' || seen.has(value)) fail('V102_ACTION_ARGUMENTS_INVALID');
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) fail('V102_ACTION_ARGUMENTS_INVALID');
  seen.add(value);
  let output;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype
        || value.length > 5000 || Object.keys(value).length !== value.length
        || Reflect.ownKeys(value).length !== value.length + 1) fail('V102_ACTION_ARGUMENTS_INVALID');
    const parts = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('V102_ACTION_ARGUMENTS_INVALID');
      parts.push(canonical(descriptor.value, seen, depth + 1));
    }
    output = '[' + parts.join(',') + ']';
  } else {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length > 5000 || ownKeys.some(key => typeof key !== 'string')) fail('V102_ACTION_ARGUMENTS_INVALID');
    const keys = ownKeys.sort();
    output = '{' + keys.map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
          || ['__proto__','constructor','prototype'].includes(key)) {
        fail('V102_ACTION_ARGUMENTS_INVALID');
      }
      return JSON.stringify(key) + ':' + canonical(descriptor.value, seen, depth + 1);
    }).join(',') + '}';
  }
  seen.delete(value);
  return output;
}

/** Canonical digest contract shared with the trusted V1-01 execution provider. */
export function v102ActionDigest(tool, args) {
  if (!safe(tool) || !plain(args)) fail('V102_ACTION_ARGUMENTS_INVALID');
  const serialized = canonical(args);
  if (Buffer.byteLength(serialized, 'utf8') > 256 * 1024) fail('V102_ACTION_ARGUMENTS_INVALID');
  return createHash('sha256').update(JSON.stringify([1, tool, serialized])).digest('hex');
}

/** Hash the exact process plan that the detached worker is about to spawn. */
export function v102PreparedPlanDigest(tool, plan) {
  if (!PROCESS_PLAN_TOOLS.has(tool)) fail('V102_PROCESS_TOOL_REQUIRED');
  if (!safe(tool) || !plain(plan) || !Array.isArray(plan.args)
      || typeof plan.file !== 'string' || !path.isAbsolute(plan.file)
      || typeof plan.cwd !== 'string' || !path.isAbsolute(plan.cwd)) {
    fail('V102_PROCESS_PLAN_INVALID');
  }
  return createHash('sha256').update(JSON.stringify([
    1, tool, canonical({ file: plan.file, args: plan.args, cwd: plan.cwd,
      timeoutMs: plan.timeoutMs ?? null, outputLimit: plan.outputLimit ?? null })
  ])).digest('hex');
}

function freezeActionArguments(value) {
  if (value === null || typeof value !== 'object') return;
  // v102ActionDigest has already checked that the graph is plain, acyclic,
  // bounded-depth and contains data-only descriptors.
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      fail('V102_ACTION_ARGUMENTS_INVALID');
    }
    freezeActionArguments(descriptor.value);
  }
  try { Object.freeze(value); }
  catch { fail('V102_ACTION_ARGUMENTS_INVALID'); }
}

function assertConfiguredProfile(config, tool, accessStatus) {
  const profile = config?.capabilityProfile;
  if (!profile || !['FULL_POWER','FULL_ACCESS'].includes(profile.tier)
      || profile.explicitlyAuthorized !== true || config?.powerMode?.enabled !== true) {
    fail('V102_CONFIGURED_POWER_PROFILE_REQUIRED');
  }
  const policy = ACTION_POLICY[tool];
  if (!policy) fail('V102_ACTION_UNSUPPORTED');
  if (!accessStatus || accessStatus.configuredTier !== profile.tier
      || !Object.hasOwn(TIER_RANK, accessStatus.effectiveTier)) {
    fail('V102_EFFECTIVE_ACCESS_STATUS_REQUIRED');
  }
  if (TIER_RANK[accessStatus.effectiveTier] > TIER_RANK[profile.tier]) {
    fail('V102_EFFECTIVE_TIER_EXCEEDS_CONFIGURED_TIER');
  }
  if (TIER_RANK[accessStatus.effectiveTier] < TIER_RANK[policy.minimumTier]) {
    fail('V102_HOST_EFFECTIVE_TIER_REQUIRED');
  }
  for (const flag of policy.flags) {
    if (flag === 'enabled') continue;
    if (config.powerMode?.[flag] !== true) fail('V102_CONFIGURED_CAPABILITY_DISABLED');
  }
  const disabled = new Set(Array.isArray(profile.disabledCapabilities) ? profile.disabledCapabilities : []);
  for (const capability of policy.capabilities) {
    if (disabled.has(capability)) fail('V102_CONFIGURED_CAPABILITY_DISABLED');
  }
}

function assertDecision(decision, expected, nowMs) {
  dataObject(decision, 'V102_AUTHORIZATION_DECISION_INVALID');
  if (decision.allowed !== true || decision.verified !== true
      || decision.tool !== expected.tool
      || decision.actionDigest !== expected.actionDigest
      || decision.planDigest !== expected.planDigest) {
    fail('V102_AUTHORIZATION_DENIED_OR_ACTION_MISMATCH');
  }
  for (const key of ['hostId','principalId','profileId','conversationId','operationId','nativeSessionId']) {
    if (!safe(decision[key])) fail('V102_AUTHORIZATION_IDENTITY_INVALID');
  }
  if (decision.operationId !== expected.operationId
      || (expected.profileId && decision.profileId !== expected.profileId)
      || (expected.hostId && decision.hostId !== expected.hostId)) {
    fail('V102_AUTHORIZATION_SCOPE_MISMATCH');
  }
  if (!/^[0-9a-f]{32,64}$/.test(decision.bindingId ?? '')) fail('V102_AUTHORIZATION_BINDING_INVALID');
  if (!HASH.test(decision.ownerScopeId ?? '')
      || !['STANDARD','FULL_POWER','FULL_ACCESS'].includes(decision.effectiveTier)
      || !Number.isSafeInteger(decision.grantRevision) || decision.grantRevision < 1
      || !Number.isSafeInteger(decision.expiresAtMs) || decision.expiresAtMs <= nowMs
      || decision.expiresAtMs - nowMs > MAX_TICKET_MS
      || !Array.isArray(decision.capabilities)
      || decision.capabilities.some(item => typeof item !== 'string' || item.length > 128)) {
    fail('V102_AUTHORIZATION_CLAIMS_INVALID');
  }
  const policy = ACTION_POLICY[expected.tool];
  if (TIER_RANK[decision.effectiveTier] < TIER_RANK[policy.minimumTier]) {
    fail('V102_EFFECTIVE_TIER_REQUIRED');
  }
  // A trusted grant cannot increase the configured profile's authorization ceiling.
  // FULL_ACCESS must be independently enrolled, not inferred from an elevated decision.
  if (TIER_RANK[decision.effectiveTier] > TIER_RANK[expected.configuredTier]) {
    fail('V102_EFFECTIVE_TIER_EXCEEDS_CONFIGURED_TIER');
  }
  if (TIER_RANK[decision.effectiveTier] > TIER_RANK[expected.effectiveTier]) {
    fail('V102_EFFECTIVE_TIER_EXCEEDS_HOST_TIER');
  }
  const capabilities = new Set(decision.capabilities);
  if (capabilities.size !== decision.capabilities.length) fail('V102_AUTHORIZATION_CLAIMS_INVALID');
  for (const capability of policy.capabilities) {
    if (!capabilities.has(capability)) fail('V102_EFFECTIVE_CAPABILITY_REQUIRED');
  }
  if (policy.nativePrivilege && decision.nativePrivilegeVerified !== true) {
    fail('V102_NATIVE_PRIVILEGE_PROOF_REQUIRED');
  }
  return decision;
}
function sameDecision(a, b) {
  for (const key of ['tool','actionDigest','planDigest','hostId','principalId','profileId',
    'conversationId','operationId','nativeSessionId','bindingId','ownerScopeId','effectiveTier',
    'grantRevision','expiresAtMs','nativePrivilegeVerified']) {
    if ((a[key] ?? null) !== (b[key] ?? null)) return false;
  }
  const left = [...a.capabilities].sort();
  const right = [...b.capabilities].sort();
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Execute only through a V1-01 trusted authorization provider.
 * authorizeExecution MUST re-observe the native owner session and exact grant
 * on every call. withLease MUST be machine-global. V1-06 owns durable receipts.
 */
export async function executeV102AuthorizedOperation({
  config, accessStatus, readAccessStatus, authorization, services, tool, args, actionDigest, planDigest = null,
  requestId, operationId, execute, now = Date.now
} = {}) {
  if (typeof execute !== 'function' || typeof now !== 'function'
      || !services || typeof services.authorizeExecution !== 'function'
      || typeof services.withLease !== 'function' || services.leaseScope !== 'machine-global'
      || !safe(services.hostId)) {
    fail('V102_TRUSTED_EXECUTION_PROVIDER_REQUIRED');
  }
  if (!safe(tool) || !safe(operationId)) fail('V102_OPERATION_ID_REQUIRED');
  // A supplied digest is only a claim. Bind it to the actual arguments before
  // consulting the owner provider, otherwise a caller can authorize one action
  // and dispatch another using the same signed digest.
  // A process-plan digest cannot substitute for a file/terminal/privilege action.
  if (planDigest !== null && !PROCESS_PLAN_TOOLS.has(tool)) fail('V102_PROCESS_TOOL_REQUIRED');
  // Detached process workers carry an independently bound prepared-plan digest.
  // Every other action must supply its actual arguments for local verification.
  if (args === undefined && planDigest === null) fail('V102_ACTION_ARGUMENTS_REQUIRED');
  const computedActionDigest = args === undefined ? null : v102ActionDigest(tool, args);
  // Caller and effect closures may retain the same object reference. Protect
  // the entire already-validated plain JSON graph before any asynchronous
  // authorization wait so the dispatched effect cannot observe new values.
  if (args !== undefined) {
    freezeActionArguments(args);
    if (v102ActionDigest(tool, args) !== computedActionDigest) {
      fail('V102_ACTION_ARGUMENTS_CHANGED');
    }
  }
  if (actionDigest != null && computedActionDigest !== null
      && actionDigest !== computedActionDigest) fail('V102_ACTION_DIGEST_ARGUMENTS_MISMATCH');
  const expectedActionDigest = actionDigest ?? computedActionDigest;
  if (!HASH.test(expectedActionDigest) || (planDigest !== null && !HASH.test(planDigest))) {
    fail('V102_ACTION_DIGEST_INVALID');
  }
  if (requestId !== undefined && !safe(requestId)) fail('V102_REQUEST_ID_INVALID');
  const admittedAccessStatus = typeof readAccessStatus === 'function'
    ? await readAccessStatus({force:true}) : accessStatus;
  if (config?.executionAccess?.required === true && typeof readAccessStatus !== 'function') {
    fail('V102_ACCESS_STATUS_READER_REQUIRED');
  }
  assertConfiguredProfile(config, tool, admittedAccessStatus);
  const nowMs = now();
  if (!Number.isSafeInteger(nowMs)) fail('V102_CLOCK_INVALID');
  const expected = Object.freeze({
    tool, actionDigest: expectedActionDigest, planDigest,
    operationId,
    profileId: config?.capabilityProfile?.id ?? config?.instance?.profile ?? null,
    configuredTier: config.capabilityProfile.tier,
    effectiveTier: admittedAccessStatus.effectiveTier,
    hostId: services.hostId ?? null
  });
  if (expected.profileId !== null && !safe(expected.profileId)) fail('V102_PROFILE_ID_INVALID');
  if (expected.hostId !== null && !safe(expected.hostId)) fail('V102_HOST_ID_INVALID');
  const context = Object.freeze({
    schema: 1, authorization, tool, actionDigest: expectedActionDigest,
    planDigest, requestId: requestId ?? null, operationId
  });
  const first = assertDecision(await services.authorizeExecution({
    ...context, phase: 'ADMISSION', nowMs
  }), expected, now());
  const result = await services.withLease(first.ownerScopeId, async () => {
    const ensureHostAccessStatus = async () => {
      const latest = typeof readAccessStatus === 'function'
        ? await readAccessStatus({force:true}) : admittedAccessStatus;
      if (!latest || latest.configuredTier !== expected.configuredTier
          || latest.effectiveTier !== expected.effectiveTier) {
        fail('V102_HOST_EFFECTIVE_TIER_CHANGED_BEFORE_EFFECT');
      }
      assertConfiguredProfile(config, tool, latest);
      return latest;
    };
    await ensureHostAccessStatus();
    const current = assertDecision(await services.authorizeExecution({
      ...context, phase: 'EXECUTION', expectedDecision: first, nowMs: now()
    }), expected, now());
    if (!sameDecision(first, current)) fail('V102_AUTHORIZATION_CHANGED_BEFORE_EFFECT');
    // Re-observe the native process token after the asynchronous owner-provider
    // round trip and immediately before the side effect/receipt callback.
    const guardedEffect = async () => {
      await ensureHostAccessStatus();
      return execute(Object.freeze({ decision: current, actionDigest: expectedActionDigest, planDigest }));
    };
    if (services.receiptStore && typeof services.receiptStore.execute === 'function') {
      if (!requestId) fail('V102_DURABLE_REQUEST_ID_REQUIRED');
      return services.receiptStore.execute({
        requestId, tool,
        input: {
          actionDigest: expectedActionDigest, planDigest,
          grantRevision: first.grantRevision, effectiveTier: first.effectiveTier,
          bindingId: first.bindingId, nativeSessionId: first.nativeSessionId,
          ownerScopeId: first.ownerScopeId, operationId
        }
      }, guardedEffect);
    }
    if (config?.executionAccess?.requireReceipt === true) fail('V102_DURABLE_RECEIPT_STORE_REQUIRED');
    return guardedEffect();
  });
  return Object.freeze({
    result,
    authorization: Object.freeze({
      effectiveTier: first.effectiveTier,
      bindingId: first.bindingId,
      grantRevision: first.grantRevision,
      ownerScopeId: first.ownerScopeId,
      actionDigest: expectedActionDigest,
      planDigest,
      expiresAtMs: first.expiresAtMs
    })
  });
}

/** Build the host-injected executionAccess.run surface used by power tools. */
export function createV102ExecutionAccess({ config, accessStatus, readAccessStatus, authorization, services, requestId, operationId, now = Date.now } = {}) {
  if (!config || !services) fail('V102_TRUSTED_EXECUTION_PROVIDER_REQUIRED');
  return Object.freeze({
    run: ({ tool, args, actionDigest, planDigest = null, requestId: nextRequestId, operationId: nextOperationId } = {}, execute) =>
      executeV102AuthorizedOperation({
        config, accessStatus, readAccessStatus, authorization, services, tool, args, actionDigest, planDigest,
        requestId: nextRequestId ?? requestId,
        operationId: nextOperationId ?? operationId,
        execute, now
      })
  });
}

/**
 * Load a V1-01 worker provider from a hash-pinned, single-link regular module
 * inside this installation's src directory. RPC data cannot choose executable code.
 */
export async function loadV102WorkerExecutionAccess({ config, spec, projectDir, accessStatus, readAccessStatus } = {}) {
  const policy = config?.executionAccess;
  if (!policy || policy.required !== true) {
    if (spec?.executionAuthorization) fail('V102_WORKER_PROVIDER_NOT_ENABLED');
    return null;
  }
  if (!spec?.executionAuthorization || !safe(spec.operationId) || !safe(spec.requestId)) {
    fail('V102_WORKER_AUTHORIZATION_REQUIRED');
  }
  if (!accessStatus || accessStatus.configuredTier !== config?.capabilityProfile?.tier) {
    fail('V102_EFFECTIVE_ACCESS_STATUS_REQUIRED');
  }
  if (typeof readAccessStatus !== 'function') fail('V102_ACCESS_STATUS_READER_REQUIRED');
  if (typeof policy.providerPath !== 'string' || !path.isAbsolute(policy.providerPath)
      || !HASH.test(policy.providerSha256 ?? '')) fail('V102_WORKER_PROVIDER_CONFIG_REQUIRED');
  const base = path.resolve(projectDir, 'src');
  const providerPath = path.resolve(policy.providerPath);
  const relative = path.relative(base, providerPath);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    fail('V102_WORKER_PROVIDER_PATH_DENIED');
  }
  const [baseReal, providerReal] = await Promise.all([realpath(base), realpath(providerPath)]);
  const realRelative = path.relative(baseReal, providerReal);
  if (!realRelative || realRelative === '..' || realRelative.startsWith('..' + path.sep) || path.isAbsolute(realRelative)) {
    fail('V102_WORKER_PROVIDER_PATH_DENIED');
  }
  const stat = fs.lstatSync(providerPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('V102_WORKER_PROVIDER_FILE_DENIED');
  const source = await readFile(providerPath);
  if (createHash('sha256').update(source).digest('hex') !== policy.providerSha256) {
    fail('V102_WORKER_PROVIDER_HASH_MISMATCH');
  }
  const provider = await import(pathToFileURL(providerPath).href);
  if (typeof provider.createWorkerExecutionAccess !== 'function') fail('V102_WORKER_PROVIDER_CONTRACT_INVALID');
  const services = await provider.createWorkerExecutionAccess({ config, spec, projectDir });
  if (!services || typeof services !== 'object'
      || typeof services.authorizeExecution !== 'function'
      || typeof services.withLease !== 'function' || services.leaseScope !== 'machine-global'
      || (services.hostId !== undefined && !safe(services.hostId))) {
    fail('V102_WORKER_PROVIDER_CONTRACT_INVALID');
  }
  return Object.freeze({
    services,
    executionAccess: createV102ExecutionAccess({
      config, accessStatus, readAccessStatus, authorization: spec.executionAuthorization, services,
      requestId: spec.requestId, operationId: spec.operationId
    })
  });
}

/** Worker helper for a prepared process plan; spawn occurs inside the gate. */
export async function executeV102WorkerProcess({ config, accessStatus, readAccessStatus, spec, services, startProcess, now = Date.now } = {}) {
  if (!spec || spec.kind !== 'process' || !spec.executionAuthorization
      || typeof startProcess !== 'function') fail('V102_WORKER_AUTHORIZATION_REQUIRED');
  const plan = {
    file: spec.file, args: spec.args, cwd: spec.cwd,
    timeoutMs: spec.timeoutMs, outputLimit: spec.outputLimit
  };
  const planDigest = v102PreparedPlanDigest(spec.tool, plan);
  const actionDigest = spec.executionAuthorization.actionDigest;
  if (!HASH.test(actionDigest ?? '') || spec.executionAuthorization.planDigest !== planDigest) {
    fail('V102_WORKER_PLAN_AUTHORIZATION_MISMATCH');
  }
  const executionAccess = createV102ExecutionAccess({
    config, accessStatus, readAccessStatus, authorization: spec.executionAuthorization, services,
    requestId: spec.requestId, operationId: spec.operationId, now
  });
  let child = null;
  const outcome = await executionAccess.run({
    tool: spec.tool, actionDigest, planDigest, requestId: spec.requestId, operationId: spec.operationId
  }, () => {
    child = startProcess();
    if (!Number.isSafeInteger(child?.pid) || child.pid < 1) fail('V102_PROCESS_START_FAILED');
    return { pid: child.pid };
  });
  return Object.freeze({ child, result: outcome.result, authorization: outcome.authorization });
}
