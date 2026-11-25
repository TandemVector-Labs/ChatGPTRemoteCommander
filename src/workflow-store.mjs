// Durable project memory. Opt-in; not an OS sandbox, scheduler, or model.
// SQLite rollback journal avoids depending on WAL fixes in bundled SQLite versions.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { isTrustedProcessCessationProof, isSerializedProcessCessationProof, serializeProcessCessationProof } from './process-containment.mjs';
import {
  AUTONOMY_REVISION, AUTONOMY_SCHEMA, normalizeWorkflowState, normalizeExecutionProfile,
  normalizeSchedulerPolicy, normalizeAuthority, authorityCompatible, classifyTool,
  reconciliationPlan, syncProjectBrain, safeRelative
} from './workflow-autonomy.mjs';

export const STORE_SCHEMA = AUTONOMY_SCHEMA;
export const MODULE_REVISION = AUTONOMY_REVISION;
const ZERO = '0'.repeat(64);
const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const EVENT_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_STATE = 512 * 1024;
const MAX_EVENTS = 10000;
const MAX_EXPORT = 4 * 1024 * 1024;
const MAX_FILE = 16 * 1024 * 1024;
const WORKER_IDENTITY_ZERO = '0'.repeat(64);
const WORKER_IDENTITY_MAX_EVENTS = 100_000;
const WORKER_IDENTITY_MAX_TTL_MS = 86_400_000;
const WORKER_REVOCATION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKER_ID_RE = /^cw_[a-f0-9]{64}$/;
const WORKER_BINDING_RE = /^[a-f0-9]{32,64}$/;
const WORKER_KEY_ID_RE = /^[a-f0-9]{64}$/;
const WORKER_B64URL_RE = /^[A-Za-z0-9_-]+$/;
const WORKER_SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WORKER_CLAIM_FIELDS = Object.freeze([
  'issuer','audience','hostId','profileId','principalId','conversationId',
  'bindingId','workerId','ownerSidHash','deviceProvider','deviceIdHash',
  'tunnelProvider','tunnelIdHash','capabilityPolicyDigest','grantRevision',
  'issuedAtMs','expiresAtMs','nonce'
]);
function workerIdentityJson(value,state={nodes:0},depth=0) {
  if (++state.nodes > 8192 || depth > 24) fail('WORKER_IDENTITY_ENVELOPE_INVALID');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || isProxy(value)) fail('WORKER_IDENTITY_ENVELOPE_INVALID');
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype
      || Reflect.ownKeys(value).length !== value.length + 1
      || Object.keys(value).length !== value.length)
      fail('WORKER_IDENTITY_ENVELOPE_INVALID');
    const out=[];
    for (let i=0;i<value.length;i++) {
      const d=Object.getOwnPropertyDescriptor(value,String(i));
      if (!d || !Object.hasOwn(d,'value') || d.enumerable !== true)
        fail('WORKER_IDENTITY_ENVELOPE_INVALID');
      out.push(workerIdentityJson(d.value,state,depth+1));
    }
    return out;
  }
  const proto=Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail('WORKER_IDENTITY_ENVELOPE_INVALID');
  const keys=Reflect.ownKeys(value);
  if (keys.length > 8192 || keys.some(k=>typeof k!=='string'))
    fail('WORKER_IDENTITY_ENVELOPE_INVALID');
  const out={};
  for (const key of keys) {
    if (['__proto__','constructor','prototype'].includes(key))
      fail('WORKER_IDENTITY_ENVELOPE_INVALID');
    const d=Object.getOwnPropertyDescriptor(value,key);
    if (!d || !Object.hasOwn(d,'value') || d.enumerable !== true)
      fail('WORKER_IDENTITY_ENVELOPE_INVALID');
    out[key]=workerIdentityJson(d.value,state,depth+1);
  }
  return out;
}
function workerIdentityOptions(value,allowed,defaults,code) {
  let safe;
  try { safe=workerIdentityJson(value===undefined?{}:value); }
  catch { fail(code); }
  if (!safe || typeof safe!=='object' || Array.isArray(safe)
    || Object.keys(safe).some(k=>!allowed.includes(k))) fail(code);
  return Object.freeze({...defaults,...safe});
}
function workerIdentityEnvelope(value) {
  const safe=workerIdentityJson(value);
  const text = canonical(safe);
  if (Buffer.byteLength(text) > 16 * 1024) fail('WORKER_IDENTITY_ENVELOPE_LIMIT');
  const envelope = JSON.parse(text);
  if (!envelope || Object.getPrototypeOf(envelope) !== Object.prototype
    || Object.keys(envelope).sort().join(',') !== ['claims','keyId','publicKey','schema','signature'].sort().join(',')
    || envelope.schema !== 1 || !WORKER_KEY_ID_RE.test(envelope.keyId)
    || typeof envelope.publicKey !== 'string' || !WORKER_B64URL_RE.test(envelope.publicKey)
    || Buffer.from(envelope.publicKey, 'base64url').length !== 44
    || Buffer.from(envelope.publicKey, 'base64url').toString('base64url') !== envelope.publicKey
    || typeof envelope.signature !== 'string' || !WORKER_B64URL_RE.test(envelope.signature)
    || Buffer.from(envelope.signature, 'base64url').length !== 64
    || Buffer.from(envelope.signature, 'base64url').toString('base64url') !== envelope.signature)
    fail('WORKER_IDENTITY_ENVELOPE_INVALID');
  const claims = envelope.claims;
  if (!claims || Object.getPrototypeOf(claims) !== Object.prototype
    || Object.keys(claims).sort().join(',') !== [...WORKER_CLAIM_FIELDS].sort().join(',')
    || !WORKER_SAFE_ID_RE.test(claims.issuer) || !WORKER_SAFE_ID_RE.test(claims.audience)
    || !WORKER_SAFE_ID_RE.test(claims.hostId) || !WORKER_SAFE_ID_RE.test(claims.profileId)
    || !WORKER_SAFE_ID_RE.test(claims.principalId) || !WORKER_SAFE_ID_RE.test(claims.conversationId)
    || !WORKER_ID_RE.test(claims.workerId) || !WORKER_BINDING_RE.test(claims.bindingId)
    || !/^[a-f0-9]{64}$/.test(claims.ownerSidHash)
    || !['tailscale','native-key-store'].includes(claims.deviceProvider)
    || !/^[a-f0-9]{64}$/.test(claims.deviceIdHash)
    || claims.tunnelProvider !== 'openai-secure-mcp-tunnel'
    || !/^[a-f0-9]{64}$/.test(claims.tunnelIdHash)
    || !/^[a-f0-9]{64}$/.test(claims.capabilityPolicyDigest)
    || !Number.isSafeInteger(claims.grantRevision) || claims.grantRevision < 1
    || !Number.isSafeInteger(claims.issuedAtMs) || claims.issuedAtMs < 0
    || !Number.isSafeInteger(claims.expiresAtMs) || claims.expiresAtMs <= claims.issuedAtMs
    || claims.expiresAtMs - claims.issuedAtMs > WORKER_IDENTITY_MAX_TTL_MS
    || typeof claims.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(claims.nonce))
    fail('WORKER_IDENTITY_CLAIMS_INVALID');
  let publicKey;
  try { publicKey = createPublicKey({key:Buffer.from(envelope.publicKey,'base64url'),type:'spki',format:'der'}); }
  catch { fail('WORKER_IDENTITY_PUBLIC_KEY_INVALID'); }
  if (publicKey.asymmetricKeyType !== 'ed25519'
    || hash(Buffer.from(envelope.publicKey,'base64url')) !== envelope.keyId)
    fail('WORKER_IDENTITY_PUBLIC_KEY_INVALID');
  const expectedWorkerId = 'cw_' + hash(Buffer.from(JSON.stringify([
    'commander.worker.identity.v1',claims.hostId,claims.profileId,claims.ownerSidHash,
    claims.deviceProvider,claims.deviceIdHash,envelope.keyId
  ]),'utf8'));
  if (claims.workerId !== expectedWorkerId) fail('WORKER_IDENTITY_CLAIMS_INVALID');
  const signedBytes = Buffer.from(JSON.stringify([
    'commander.worker.identity.v1',envelope.keyId,...WORKER_CLAIM_FIELDS.map(key=>claims[key])
  ]),'utf8');
  if (!verify(null,signedBytes,publicKey,Buffer.from(envelope.signature,'base64url')))
    fail('WORKER_IDENTITY_SIGNATURE_INVALID');
  Object.freeze(claims);
  Object.freeze(envelope);
  return Object.freeze({
    text, envelope, workerId: claims.workerId, bindingId: claims.bindingId,
    signature: envelope.signature, expiresAtMs: claims.expiresAtMs
  });
}
export const fail = code => { throw Object.assign(new Error(code), { workflowCode: code }); };
export const hash = data => createHash('sha256').update(data).digest('hex');

export function canonical(value, depth = 0) {
  if (depth > 24) fail('WORKFLOW_JSON_DEPTH');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(x => canonical(x, depth + 1)).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value).sort();
    if (keys.some(k => ['__proto__', 'constructor', 'prototype'].includes(k))) fail('WORKFLOW_JSON_KEY');
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(value[k], depth + 1)).join(',') + '}';
  }
  fail('WORKFLOW_JSON_VALUE');
}
const jsonHash = v => hash(canonical(v));
const identifier = id => { if (typeof id !== 'string' || !ID.test(id)) fail('WORKFLOW_INVALID_ID'); return id; };
const revision = n => { if (!Number.isSafeInteger(n) || n < 0) fail('WORKFLOW_REVISION_REQUIRED'); return n; };
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const leaseRootKey = value => { const resolved=path.resolve(value); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };
export function inside(root, candidate) {
  let a = path.resolve(root), b = path.resolve(candidate);
  if (process.platform === 'win32') { a = a.toLowerCase(); b = b.toLowerCase(); }
  const r = path.relative(a, b);
  return r === '' || (r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r));
}
export function safeText(value, max = 8000) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || !value.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail('WORKFLOW_INVALID_TEXT');
  // A leak guard, NOT a complete secret/PII classifier. Never put secrets in memory.
  if (/\b(?:sk|ghp|github_pat)[-_][A-Za-z0-9_-]{16,}|\bBearer\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:password|api[_ -]?key|access[_ -]?token|secret)\s*[=:]\s*\S+/i.test(value)) fail('WORKFLOW_SECRET_NOT_ALLOWED');
  return value;
}
function noLinks(target, existing = true) {
  const resolved = path.resolve(target);
  let cursor = path.parse(resolved).root;
  for (const bit of resolved.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, bit);
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) fail('WORKFLOW_LINK_NOT_ALLOWED');
    } catch (e) { if (e.code !== 'ENOENT' || existing) throw e; break; }
  }
  return resolved;
}
function rootWithin(target, roots) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) fail('WORKFLOW_ABSOLUTE_ROOT_REQUIRED');
  noLinks(target);
  const actual = fs.realpathSync.native(target);
  if (!fs.statSync(actual).isDirectory() || !roots.some(r => inside(r, actual))) fail('WORKFLOW_ROOT_OUT_OF_SCOPE');
  return actual;
}
function clone(value) { return JSON.parse(canonical(value)); }
function receiptFields(result) {
  const receipt = {};
  for (const k of ['exitCode', 'timedOut', 'isError', 'ok', 'submitted', 'visualVerificationRequired']) {
    if (result && Object.hasOwn(result, k) && ['boolean', 'number'].includes(typeof result[k])) receipt[k] = result[k];
  }
  const raw = canonical(result ?? null);
  if (Buffer.byteLength(raw) > 8 * 1024 * 1024) fail('WORKFLOW_RECEIPT_TOO_LARGE');
  return { ...receipt, resultSha256: hash(raw), outputStored: false };
}
const NONTERMINAL_EFFECT_STATUS = new Set([
  'QUEUED','PENDING','RUNNING','IN_PROGRESS','STARTING','SUBMITTED',
  'ACCEPTED','BACKGROUND','WAITING','WAITING_INPUT','RETRY_SCHEDULED'
]);
function deferredEffect(r) {
  if (!r || typeof r !== 'object') return false;
  if (r.submitted === true) return true;
  const candidates=[r.status,r.state?.status,r.task?.status];
  return candidates.some(value=>typeof value === 'string'
    && NONTERMINAL_EFFECT_STATUS.has(value.toUpperCase()));
}
const NEGATIVE_EFFECT_STATUS = new Set([
  'FAILED','ERROR','CANCELLED','CANCELED','TIMED_OUT','REJECTED','ABORTED',
  'UNCERTAIN'
]);
const VERIFIED_TERMINAL_EFFECT_STATUS = new Set(['SUCCEEDED','COMPLETED','SUCCESS']);
function terminalEffectFailure(r) {
  if (r == null) return true; // No receipt is not proof of completion.
  if (typeof r !== 'object') return false;
  const candidates=[r.status,r.state?.status,r.task?.status];
  if (candidates.some(value=>typeof value === 'string'
    && NEGATIVE_EFFECT_STATUS.has(value.toUpperCase()))) return true;
  // New native operation states are not affirmative evidence of completion.
  // Generic tool content may have a domain-specific "status"; restrict the
  // default-deny rule to responses carrying a durable operation identity.
  if (typeof r.operationId === 'string' && r.operationId) {
    const states=candidates.filter(value=>typeof value === 'string');
    if (states.length && !states.some(value=>VERIFIED_TERMINAL_EFFECT_STATUS.has(value.toUpperCase()))) {
      return true;
    }
  }
  return false;
}
function nestedOperationFailure(r) {
  if (!r || typeof r !== 'object' || !r.state || typeof r.state !== 'object'
    || !Object.hasOwn(r, 'result')) return false;
  const inner=r.result;
  if (terminalEffectFailure(inner) || deferredEffect(inner)) return true;
  return inner?.timedOut === true || inner?.isError === true || inner?.ok === false
    || inner?.exitCode === null || (typeof inner?.exitCode === 'number' && inner.exitCode !== 0);
}
function nativeReceiptIdentityMismatch(r, expectedOperationId) {
  if (!r || typeof r !== 'object' || !r.state || typeof r.state !== 'object'
    || !Object.hasOwn(r, 'result')) return false;
  // Preserve the primary DEFERRED/FAILED reason before checking identity.
  // An uncompleted nested task cannot be used to release a root lease anyway.
  if (deferredEffect(r) || terminalEffectFailure(r) || nestedOperationFailure(r)) return false;
  // A native operation_result belongs to the journaled workflow intent,
  // not merely to any process that returned exitCode=0.
  const nativeOperationId=r.state.operationId, innerOperationId=r.result?.operationId;
  // Any native-shaped receipt needs a complete, consistent identity tuple.
  // Missing fields must not turn a Native success into an anonymous receipt.
  const hasIdentity=[r.state.requestId,nativeOperationId,innerOperationId]
    .some(value=>value !== undefined);
  // A terminal native-shaped wrapper is never a valid anonymous success,
  // even if every operation identity field has been stripped by its caller.
  if (!hasIdentity) return typeof r.state.status === 'string'
    && VERIFIED_TERMINAL_EFFECT_STATUS.has(r.state.status.toUpperCase());
  return typeof r.state.requestId !== 'string' || r.state.requestId !== expectedOperationId
    || typeof nativeOperationId !== 'string' || nativeOperationId.length === 0
    || typeof innerOperationId !== 'string' || innerOperationId.length === 0
    || innerOperationId !== nativeOperationId;
}
const NATIVE_NO_PROCESS_TOOLS = new Set([
  'system_status','read_text','read_file','write_text','write_file','list_directory',
  'file_info','create_directory','copy_path','move_path','delete_path',
  'search_files','power_status','system_info','list_processes','read_terminal',
  'gui_status','gui_screenshot','gui_list_windows','gui_cursor_position'
]);
function nativeExecutionNeedsCessationProof(r, invokedTool) {
  // A process-capable committed tool needs cessation evidence even when a
  // native adapter flattens or drops all native receipt fields.
  if (!NATIVE_NO_PROCESS_TOOLS.has(invokedTool)) return true;
  if (!r || typeof r !== 'object' || !r.state || typeof r.state !== 'object'
    || !Object.hasOwn(r, 'result') || !r.result || typeof r.result !== 'object'
    || typeof r.state.status !== 'string'
    || !VERIFIED_TERMINAL_EFFECT_STATUS.has(r.state.status.toUpperCase())) return false;
  // A successful native receipt proves the direct operation ended, not that
  // detached descendants have ceased. A missing/unknown tool fails closed.
  const tools=[r.state.tool, r.result.tool].filter(t=>typeof t === 'string');
  return tools.length === 0 || tools.some(t=>!NATIVE_NO_PROCESS_TOOLS.has(t));
}
function badResult(r) { return deferredEffect(r) || terminalEffectFailure(r) || nestedOperationFailure(r) || r?.timedOut === true || r?.isError === true || r?.ok === false || (typeof r?.exitCode === 'number' && r.exitCode !== 0) || r?.exitCode === null; }

// Explicit control is independent of scheduling: scheduler-off workflows still
// permit direct authorized calls. Late receipts must never clear user intent.
function controlBlocker(state) {
  if (state.lifecycleState === 'COMPLETED') return 'WORKFLOW_ALREADY_COMPLETED';
  if (state.control?.intent === 'CANCELLED' || state.lifecycleState === 'CANCELLED') return 'WORKFLOW_CANCELLED';
  if (state.control?.intent === 'PAUSED') return 'WORKFLOW_PAUSED';
  return null;
}
function requireActive(state) {
  const blocker = controlBlocker(state);
  if (blocker) fail(blocker);
}
function setLifecycle(state, next) {
  const blocker = controlBlocker(state);
  state.lifecycleState = blocker === 'WORKFLOW_ALREADY_COMPLETED' ? 'COMPLETED'
    : blocker === 'WORKFLOW_CANCELLED' ? 'CANCELLED'
    : blocker === 'WORKFLOW_PAUSED' ? 'WAITING' : next;
  if (blocker) {
    state.scheduler.enabled = false;
    state.scheduler.automaticContinuation = false;
  }
}
function requireExpectedEvidence(evidence, expected) {
  if (expected === undefined) return;
  if (!Array.isArray(expected) || expected.length !== evidence.length) fail('WORKFLOW_EVIDENCE_CHANGED');
  const paths = new Set();
  for (const item of expected) {
    if (!item || typeof item.path !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '') || paths.has(item.path)) fail('WORKFLOW_EVIDENCE_CHANGED');
    paths.add(item.path);
    const actual = evidence.find(ref => ref.path === item.path);
    if (!actual || actual.sha256 !== item.sha256 || (item.bytes !== undefined && actual.bytes !== item.bytes)) fail('WORKFLOW_EVIDENCE_CHANGED');
  }
}

function planRecord(value, allowed, required) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail('WORKFLOW_PLAN_INPUT_INVALID');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !allowed.includes(key)
    || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)
    || required.some(key => !Object.hasOwn(descriptors, key))) fail('WORKFLOW_PLAN_INPUT_INVALID');
}
function planArray(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail('WORKFLOW_PLAN_INPUT_INVALID');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) fail('WORKFLOW_PLAN_INPUT_INVALID');
  for (let i = 0; i < value.length; i++) {
    const descriptor = descriptors[i];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('WORKFLOW_PLAN_INPUT_INVALID');
  }
}
function structuralPlanHash(steps) {
  return jsonHash(steps.map(({ id, title, dependsOn }) => ({ id, title, dependsOn })));
}
function requireOrderedPlan(steps) {
  const seen = new Set();
  for (const step of steps) {
    if (seen.has(step.id)) fail('WORKFLOW_DUPLICATE_STEP');
    if (!Array.isArray(step.dependsOn) || step.dependsOn.some(dep => !seen.has(dep))
      || new Set(step.dependsOn).size !== step.dependsOn.length) fail('WORKFLOW_INVALID_DEPENDENCY');
    seen.add(step.id);
  }
}

export class WorkflowStore {
  #db;
  #leaseDb;
  #roots;
  #device;
  #configSha;
  #instance = randomUUID();
  #dbPath;
  #leaseDbPath;
  #profileId;
  #closed = false;
  #authority;
  #executionProfile;
  #schedulerPolicy;
  #workerId = randomUUID();
  #startupRecovery = { scanned:0, recovered:0, truncated:false, limit:2000 };
  constructor({ directory, rootLeaseDirectory = directory, allowedRoots, device = os.hostname(), configSha256 = ZERO, authority = {}, executionProfile = {}, schedulerPolicy = {} }) {
    if (!Array.isArray(allowedRoots) || !allowedRoots.length) fail('WORKFLOW_ROOTS_REQUIRED');
    this.#roots = allowedRoots.map(r => { noLinks(r); return fs.realpathSync.native(r); });
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || /^(?:\\\\|\/\/)/.test(directory)) fail('WORKFLOW_LOCAL_STORE_REQUIRED');
    // Storage is operator-configured private local state, separate from project roots.
    // Workflow project/evidence roots remain enforced independently by rootWithin().
    noLinks(directory, false);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const dir = fs.realpathSync.native(directory);
    if (!fs.statSync(dir).isDirectory()) fail('WORKFLOW_LOCAL_STORE_REQUIRED');
    this.#dbPath = path.join(dir, 'workflows.sqlite');
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      noLinks(this.#dbPath + suffix, false);
      // SQLite may delete its rollback journal between inspection and lstat.
      // Treat only ENOENT as an absent transient file; all aliases still fail.
      try {
        const s = fs.lstatSync(this.#dbPath + suffix);
        if (!s.isFile() || s.isSymbolicLink() || s.nlink > 1) fail('WORKFLOW_DATABASE_ALIAS');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    this.#device = safeText(device, 128);
    if (!/^[a-f0-9]{64}$/.test(configSha256)) fail('WORKFLOW_CONFIG_HASH_REQUIRED');
    this.#configSha = configSha256;
    this.#authority = normalizeAuthority(authority);
    this.#profileId = safeText(this.#authority.profileId ?? 'default', 128);
    this.#executionProfile = normalizeExecutionProfile(executionProfile);
    this.#schedulerPolicy = normalizeSchedulerPolicy(schedulerPolicy);

    if (typeof rootLeaseDirectory !== 'string' || !path.isAbsolute(rootLeaseDirectory) || /^(?:\\|\/\/)/.test(rootLeaseDirectory)) fail('WORKFLOW_ROOT_LEASE_STORE_REQUIRED');
    noLinks(rootLeaseDirectory, false);
    fs.mkdirSync(rootLeaseDirectory, { recursive: true, mode: 0o700 });
    const leaseDir = fs.realpathSync.native(rootLeaseDirectory);
    if (!fs.statSync(leaseDir).isDirectory()) fail('WORKFLOW_ROOT_LEASE_STORE_REQUIRED');
    this.#leaseDbPath = path.join(leaseDir, 'root-leases.sqlite');
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      noLinks(this.#leaseDbPath + suffix, false);
      try {
        const stat = fs.lstatSync(this.#leaseDbPath + suffix);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) fail('WORKFLOW_ROOT_LEASE_DATABASE_ALIAS');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    this.#leaseDb = new DatabaseSync(this.#leaseDbPath, { allowExtension: false });
    fs.chmodSync(this.#leaseDbPath, 0o600);
    this.#leaseDb.exec('PRAGMA busy_timeout=3000; PRAGMA trusted_schema=OFF;');
    if (this.#leaseDb.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete') fail('WORKFLOW_ROOT_LEASE_JOURNAL_MODE');
    this.#leaseDb.exec(`PRAGMA synchronous=EXTRA;
      CREATE TABLE IF NOT EXISTS root_leases(
        root TEXT PRIMARY KEY, profile TEXT NOT NULL, workflow TEXT NOT NULL,
        owner TEXT NOT NULL, expires_at TEXT NOT NULL, revision INTEGER NOT NULL,
        fencing_token INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS root_lease_counters(
        root TEXT PRIMARY KEY, last_token INTEGER NOT NULL CHECK(last_token >= 0)
      );
      CREATE TRIGGER IF NOT EXISTS root_lease_counters_no_regress
        BEFORE UPDATE OF last_token ON root_lease_counters WHEN NEW.last_token <= OLD.last_token
        BEGIN SELECT RAISE(ABORT, 'ROOT_FENCE_TOKEN_REUSE'); END;
      CREATE TRIGGER IF NOT EXISTS root_lease_counters_no_delete
        BEFORE DELETE ON root_lease_counters
        BEGIN SELECT RAISE(ABORT, 'ROOT_FENCE_COUNTER_DELETE'); END;`);
    // Upgrade existing machine-global lease stores without dropping active leases.
    // Legacy holders retain token 0 and continue blocking until they release/expire.
    const leaseColumns=this.#leaseDb.prepare('PRAGMA table_info(root_leases)').all().map(column=>column.name);
    if(!leaseColumns.includes('fencing_token'))
      this.#leaseDb.exec('ALTER TABLE root_leases ADD COLUMN fencing_token INTEGER NOT NULL DEFAULT 0;');

    // Older Windows stores may have case-preserving root keys. Normalize both
    // lease and counter keys atomically before any acquisition; reject aliases
    // rather than silently dropping an active holder or reusing a fence token.
    if(process.platform==='win32'){
      this.#leaseDb.exec('BEGIN IMMEDIATE');
      try{
        for(const table of ['root_leases','root_lease_counters']){
          const rows=this.#leaseDb.prepare(`SELECT root FROM ${table}`).all();
          const normalized=new Set();
          for(const row of rows){
            const key=leaseRootKey(row.root);
            if(normalized.has(key))fail('WORKFLOW_ROOT_LEASE_ALIAS_COLLISION');
            normalized.add(key);
          }
          for(const row of rows){
            const key=leaseRootKey(row.root);
            if(key!==row.root)this.#leaseDb.prepare(`UPDATE ${table} SET root=? WHERE root=?`).run(key,row.root);
          }
        }
        this.#leaseDb.exec('COMMIT');
      }catch(error){
        try{this.#leaseDb.exec('ROLLBACK');}catch{}
        throw error;
      }
    }

    try {
      this.#leaseDb.exec('BEGIN IMMEDIATE');
      this.#leaseDb.exec(
        'CREATE TABLE IF NOT EXISTS worker_identity_meta(' +
        'singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL,' +
        'event_count INTEGER NOT NULL,head_digest TEXT NOT NULL);' +
        'CREATE TABLE IF NOT EXISTS worker_identity_events(' +
        'seq INTEGER PRIMARY KEY AUTOINCREMENT,worker_id TEXT NOT NULL,binding_id TEXT NOT NULL,' +
        "kind TEXT NOT NULL CHECK(kind IN ('REGISTERED','REVOKED')),body TEXT NOT NULL," +
        'previous_digest TEXT NOT NULL,digest TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);' +
        'CREATE INDEX IF NOT EXISTS worker_identity_events_binding ON worker_identity_events(worker_id,binding_id,kind);' +
        "CREATE TRIGGER IF NOT EXISTS worker_identity_events_no_update BEFORE UPDATE ON worker_identity_events BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;" +
        "CREATE TRIGGER IF NOT EXISTS worker_identity_events_no_delete BEFORE DELETE ON worker_identity_events BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;" +
        'CREATE TABLE IF NOT EXISTS worker_identity_registry(' +
        "worker_id TEXT PRIMARY KEY,binding_id TEXT NOT NULL,signature TEXT NOT NULL,envelope TEXT NOT NULL," +
        "state TEXT NOT NULL CHECK(state IN ('ACTIVE','REVOKED')),event_seq INTEGER NOT NULL);"
      );
      this.#leaseDb.prepare(
        'INSERT OR IGNORE INTO worker_identity_meta(singleton,schema_version,event_count,head_digest) VALUES(1,1,0,?)'
      ).run(WORKER_IDENTITY_ZERO);
      this.#leaseDb.exec('COMMIT');
      this.#verifyWorkerIdentityJournal();
    } catch(error) {
      try { this.#leaseDb.exec('ROLLBACK'); } catch {}
      try { this.#leaseDb.close(); } catch {}
      throw error;
    }

    this.#db = new DatabaseSync(this.#dbPath, { allowExtension: false });
    try {
      fs.chmodSync(this.#dbPath, 0o600);
      this.#db.exec('PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;');
      // Do not silently convert an existing database made by another configuration.
      const mode = this.#db.prepare('PRAGMA journal_mode').get().journal_mode;
      if (mode !== 'delete') fail('WORKFLOW_UNEXPECTED_JOURNAL_MODE');
      this.#db.exec('PRAGMA synchronous=EXTRA;');
      let userVersion = this.#db.prepare('PRAGMA user_version').get().user_version;
      if (![0, 1, STORE_SCHEMA].includes(userVersion)) fail('WORKFLOW_SCHEMA_UNSUPPORTED');
      if (userVersion === 0) {
        this.#db.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE IF NOT EXISTS workflows(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, head TEXT NOT NULL, snapshot TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS events(workflow TEXT NOT NULL REFERENCES workflows(id), seq INTEGER NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(workflow,seq));
          CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;
          CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;
          PRAGMA user_version=1;
          COMMIT;
        `);
        userVersion = 1;
      }
      if (userVersion === 1) {
        this.#db.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE IF NOT EXISTS scheduler_jobs(
            workflow TEXT PRIMARY KEY REFERENCES workflows(id) ON DELETE CASCADE,
            lifecycle TEXT NOT NULL, enabled INTEGER NOT NULL, next_run_at TEXT,
            lease_owner TEXT, lease_until TEXT, retry_count INTEGER NOT NULL DEFAULT 0,
            last_failure TEXT, updated_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS operations(
            operation_id TEXT PRIMARY KEY,
            workflow TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
            step_id TEXT NOT NULL, attempt_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
            classification TEXT NOT NULL, status TEXT NOT NULL, tool TEXT NOT NULL,
            input_hash TEXT NOT NULL, verification TEXT, pre_state_hash TEXT, result_status TEXT, exit_code INTEGER,
            post_state_hash TEXT, receipt TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS operations_workflow_step ON operations(workflow,step_id);
          CREATE INDEX IF NOT EXISTS operations_status_workflow_updated ON operations(status,workflow,updated_at DESC);
          CREATE INDEX IF NOT EXISTS scheduler_jobs_enabled_workflow ON scheduler_jobs(enabled,workflow);
          CREATE INDEX IF NOT EXISTS scheduler_jobs_lifecycle_updated_workflow ON scheduler_jobs(lifecycle,updated_at DESC,workflow);
          CREATE TABLE IF NOT EXISTS root_leases(
            root TEXT PRIMARY KEY, workflow TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
            owner TEXT NOT NULL, expires_at TEXT NOT NULL, revision INTEGER NOT NULL
          );
          COMMIT;
        `);
      }
      if (this.#db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('WORKFLOW_DATABASE_CORRUPT');
      const rows = this.#db.prepare('SELECT id,snapshot FROM workflows ORDER BY id').all();
      const now = new Date().toISOString();
      for (const row of rows) {
        let st = null; try { st = JSON.parse(row.snapshot); } catch { continue; }
        const enabled = st?.scheduler?.enabled === true || (st?.scheduler == null && this.#schedulerPolicy.enabled);
        const lifecycle = typeof st?.lifecycleState === 'string' ? st.lifecycleState : 'CREATED';
        this.#db.prepare('INSERT OR IGNORE INTO scheduler_jobs(workflow,lifecycle,enabled,next_run_at,lease_owner,lease_until,retry_count,last_failure,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(row.id,lifecycle,enabled?1:0,null,null,null,0,null,now);
      }
    } catch (e) { this.#db.close(); this.#leaseDb.close(); throw e; }
    this.#startupRecovery = this.recoverInterruptedBacklog();
  }
  close() { if (!this.#closed) { this.#db.close(); this.#leaseDb.close(); this.#closed = true; } }
  get location() { return this.#dbPath; }

  schedulerStatus() {
    const counts = {};
    for (const row of this.#db.prepare('SELECT lifecycle,COUNT(*) AS n FROM scheduler_jobs GROUP BY lifecycle').all()) counts[row.lifecycle] = Number(row.n);
    const pending = this.#db.prepare("SELECT COUNT(*) AS n FROM scheduler_jobs WHERE enabled=1 AND lifecycle NOT IN ('COMPLETED','FAILED','CANCELLED')").get().n;
    const interrupted = this.#db.prepare("SELECT COUNT(*) AS n FROM scheduler_jobs WHERE lifecycle='INTERRUPTED'").get().n;
    const leaseNow = new Date().toISOString();
    this.#leaseDb.prepare('DELETE FROM root_leases WHERE expires_at <= ?').run(leaseNow);
    const leases = this.#leaseDb.prepare('SELECT COUNT(*) AS n FROM root_leases WHERE expires_at > ?').get(leaseNow).n;
    const reconciliationRequired = this.#db.prepare("SELECT COUNT(*) AS n FROM operations WHERE status='UNCERTAIN'").get().n;
    return {
      enabled: this.#schedulerPolicy.enabled,
      automaticContinuation: this.#schedulerPolicy.enabled,
      automaticContinuationScope: 'RECOVERY_AND_READINESS_ONLY',
      automaticExecution: false,
      runnerConfigured: false,
      pending: Number(pending),
      persistedNonterminal: Number(pending),
      pendingMeaning: 'PERSISTED_NONTERMINAL_RECORDS_NOT_LIVE_QUEUE',
      interrupted: Number(interrupted),
      reconciliationRequired: Number(reconciliationRequired),
      currentLeases: Number(leases),
      hasActiveLease: Number(leases) > 0,
      lifecycleCounts: counts,
      workerId: this.#workerId,
      startupRecovery: clone(this.#startupRecovery),
      policy: clone(this.#schedulerPolicy)
    };
  }

  recoverInterruptedBacklog({ limit = 2000, batchSize = 100 } = {}) {
    const cap = Number.isSafeInteger(Number(limit)) ? Math.max(1, Math.min(10000, Number(limit))) : 2000;
    const batch = Number.isSafeInteger(Number(batchSize)) ? Math.max(1, Math.min(250, Number(batchSize))) : 100;
    let after = '', scanned = 0;
    const recovered = [];
    const select = this.#db.prepare("SELECT w.id FROM workflows w WHERE w.id>? AND (EXISTS (SELECT 1 FROM scheduler_jobs s WHERE s.workflow=w.id AND s.lifecycle='RUNNING') OR EXISTS (SELECT 1 FROM operations o WHERE o.workflow=w.id AND o.status IN ('PREPARED','EXECUTING'))) ORDER BY w.id LIMIT ?");
    while (scanned < cap) {
      const ids = select.all(after, Math.min(batch, cap - scanned)).map(row=>row.id);
      if (!ids.length) break;
      scanned += ids.length;
      after = ids.at(-1);
      recovered.push(...this.recoverInterrupted(ids));
      if (ids.length < batch) break;
    }
    const remaining = Number(this.#db.prepare("SELECT COUNT(*) AS n FROM workflows w WHERE w.id>? AND (EXISTS (SELECT 1 FROM scheduler_jobs s WHERE s.workflow=w.id AND s.lifecycle='RUNNING') OR EXISTS (SELECT 1 FROM operations o WHERE o.workflow=w.id AND o.status IN ('PREPARED','EXECUTING')))").get(after).n);
    return { scanned, recovered: recovered.length, recoveredIds: recovered.slice(0,100), truncated: remaining > 0, remaining, limit: cap };
  }
  recoverInterrupted(ids = null) {
    const recovered = [];
    const selected = Array.isArray(ids)
      ? [...new Set(ids.filter(id => typeof id === 'string' && ID.test(id)))]
      : this.#db.prepare("SELECT w.id FROM workflows w WHERE EXISTS (SELECT 1 FROM scheduler_jobs s WHERE s.workflow=w.id AND s.lifecycle='RUNNING') OR EXISTS (SELECT 1 FROM operations o WHERE o.workflow=w.id AND o.status IN ('PREPARED','EXECUTING')) ORDER BY w.id LIMIT 25").all().map(x=>x.id);
    for (const id of selected) {
      let loaded; try { loaded = this.#load(id); } catch { continue; }
      const dead = loaded.state.steps.filter(step => {
        if (step.status !== 'running') return false;
        if (step.ownerHost !== os.hostname() || !Number.isSafeInteger(step.ownerPid)) return true;
        try { process.kill(step.ownerPid,0); return false; } catch (e) { return e.code === 'ESRCH'; }
      });
      if (!dead.length) continue;
      const updated = this.#transaction(() => {
        const { state, head } = this.#load(id);
        const affected = [];
        for (const step of state.steps) {
          if (!dead.some(x=>x.id===step.id) || step.status !== 'running') continue;
          step.status = 'uncertain';
          if (step.operationId) {
            this.#db.prepare("UPDATE operations SET status='UNCERTAIN',result_status='INTERRUPTED',updated_at=? WHERE operation_id=?")
              .run(new Date().toISOString(), step.operationId);
          }
          affected.push(step.id);
        }
        if (!affected.length) return null;
        setLifecycle(state, 'INTERRUPTED');
        state.scheduler.lastFailureCode = 'INTERRUPTED_EXECUTION';
        const result = this.#commit(state, head, 'interruption_recovered', { steps: affected });
        this.#db.prepare("UPDATE scheduler_jobs SET lifecycle=?,enabled=?,last_failure='INTERRUPTED_EXECUTION',updated_at=? WHERE workflow=?")
          .run(state.lifecycleState, state.scheduler.enabled ? 1 : 0, new Date().toISOString(), id);
        return result;
      });
      if (updated) recovered.push(id);
    }
    return recovered;
  }
  capabilities() {
    const scheduler = this.schedulerStatus();
    return { revision: MODULE_REVISION, schema: STORE_SCHEMA, journal: 'delete', synchronous: 'extra',
      sqliteVersion: this.#db.prepare('SELECT sqlite_version() AS version').get().version,
      databaseSchemaVersion: this.#db.prepare('PRAGMA user_version').get().user_version,
      node: process.versions.node, automaticReplay: false,
      automaticContinuation: this.#schedulerPolicy.enabled,
      automaticContinuationScope: 'RECOVERY_AND_READINESS_ONLY', automaticExecution: false, runnerConfigured: false,
      scheduler: this.#schedulerPolicy.enabled, schedulerPolicy: clone(this.#schedulerPolicy),
      schedulerState: scheduler, rawArgumentsStored: false, rawOutputsStored: false,
      authenticationBoundary: false, newScopeBeyondConfiguredRoots: false,
      privateLocalStorage: true, executionProfilePersistence: true, projectBrainIntegration: true,
      operationJournal: true, oneWriterPerRoot: this.#schedulerPolicy.oneWriterPerRoot, oneWriterScope: 'machine' };
  }
  #transaction(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.#db.exec('COMMIT'); return value; }
    catch (e) { try { this.#db.exec('ROLLBACK'); } catch { /* preserve original exception */ } throw e; }
  }
  #leaseTransaction(fn) {
    this.#leaseDb.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.#leaseDb.exec('COMMIT'); return value; }
    catch (e) { try { this.#leaseDb.exec('ROLLBACK'); } catch { /* preserve original exception */ } throw e; }
  }
  #leaseReadTransaction(fn) {
    this.#leaseDb.exec('BEGIN');
    try { const value = fn(); this.#leaseDb.exec('COMMIT'); return value; }
    catch (e) { try { this.#leaseDb.exec('ROLLBACK'); } catch { /* preserve original exception */ } throw e; }
  }
  #verifyWorkerIdentityJournal() {
    const meta = this.#leaseDb.prepare(
      'SELECT schema_version AS schemaVersion,event_count AS eventCount,head_digest AS headDigest FROM worker_identity_meta WHERE singleton=1'
    ).get();
    if (!meta || meta.schemaVersion !== 1 || !Number.isSafeInteger(meta.eventCount)
      || meta.eventCount < 0 || meta.eventCount > WORKER_IDENTITY_MAX_EVENTS
      || !/^[a-f0-9]{64}$/.test(meta.headDigest))
      fail('WORKER_IDENTITY_JOURNAL_CORRUPT');
    const rows = this.#leaseDb.prepare(
      'SELECT seq,worker_id AS workerId,binding_id AS bindingId,kind,body,previous_digest AS previousDigest,digest,created_at AS createdAt FROM worker_identity_events ORDER BY seq'
    ).all();
    if (rows.length !== meta.eventCount) fail('WORKER_IDENTITY_JOURNAL_CORRUPT');
    let previous = WORKER_IDENTITY_ZERO;
    const latest = new Map();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.seq !== i + 1 || row.previousDigest !== previous
        || !/^[a-f0-9]{64}$/.test(row.digest)
        || hash(previous + '\n' + row.body) !== row.digest)
        fail('WORKER_IDENTITY_JOURNAL_CORRUPT');
      let event;
      try { event = JSON.parse(row.body); } catch { fail('WORKER_IDENTITY_JOURNAL_CORRUPT'); }
      if (canonical(event) !== row.body || event.schema !== 1
        || event.kind !== row.kind || event.workerId !== row.workerId
        || event.bindingId !== row.bindingId || typeof event.at !== 'string'
        || !Number.isFinite(Date.parse(event.at)) || new Date(event.at).toISOString() !== event.at
        || row.createdAt !== event.at)
        fail('WORKER_IDENTITY_JOURNAL_CORRUPT');
      if (row.kind === 'REGISTERED') {
        if (Object.keys(event).sort().join(',') !== ['at','bindingId','envelope','kind','schema','workerId'].sort().join(','))
          fail('WORKER_IDENTITY_JOURNAL_CORRUPT');
        const record = workerIdentityEnvelope(event.envelope);
        const eventAtMs = Date.parse(event.at);
        if (record.workerId !== row.workerId || record.bindingId !== row.bindingId
          || record.envelope.claims.issuedAtMs > eventAtMs || record.expiresAtMs <= eventAtMs)
          fail('WORKER_IDENTITY_JOURNAL_CORRUPT');
        const prior = latest.get(row.workerId);
        if (prior) {
          const expiredAtEvent = prior.expiresAtMs <= eventAtMs;
          if (prior.bindingId === row.bindingId || (prior.state !== 'REVOKED' && !expiredAtEvent))
            fail('WORKER_IDENTITY_JOURNAL_CORRUPT');
        }
        latest.set(row.workerId, {
          bindingId: record.bindingId, signature: record.signature,
          envelope: record.text, expiresAtMs: record.expiresAtMs,
          state: 'ACTIVE', eventSeq: row.seq
        });
      } else if (row.kind === 'REVOKED') {
        if (Object.keys(event).sort().join(',') !== ['at','bindingId','expectedSignature','kind','receipt','schema','workerId'].sort().join(','))
          fail('WORKER_IDENTITY_JOURNAL_CORRUPT');
        const prior = latest.get(row.workerId);
        const receipt = event.receipt;
        if (!prior || prior.bindingId !== row.bindingId || prior.signature !== event.expectedSignature
          || prior.state !== 'ACTIVE' || !receipt || Object.getPrototypeOf(receipt) !== Object.prototype
          || Object.keys(receipt).sort().join(',') !== ['reasonCode','revocationId','revokedAtMs'].sort().join(',')
          || typeof receipt.reasonCode !== 'string' || !WORKER_SAFE_ID_RE.test(receipt.reasonCode)
          || typeof receipt.revocationId !== 'string' || !WORKER_REVOCATION_UUID_RE.test(receipt.revocationId)
          || !Number.isSafeInteger(receipt.revokedAtMs) || receipt.revokedAtMs < 0
          || receipt.revokedAtMs > Date.parse(event.at) + 5000)
          fail('WORKER_IDENTITY_JOURNAL_CORRUPT');
        prior.state = 'REVOKED';
        prior.eventSeq = row.seq;
      } else fail('WORKER_IDENTITY_JOURNAL_CORRUPT');
      previous = row.digest;
    }
    if (previous !== meta.headDigest) fail('WORKER_IDENTITY_JOURNAL_CORRUPT');
    const projected = this.#leaseDb.prepare(
      'SELECT worker_id AS workerId,binding_id AS bindingId,signature,envelope,state,event_seq AS eventSeq FROM worker_identity_registry ORDER BY worker_id'
    ).all();
    if (projected.length !== latest.size) fail('WORKER_IDENTITY_PROJECTION_CORRUPT');
    for (const row of projected) {
      const expected = latest.get(row.workerId);
      if (!expected || row.bindingId !== expected.bindingId || row.signature !== expected.signature
        || row.envelope !== expected.envelope || row.state !== expected.state || row.eventSeq !== expected.eventSeq)
        fail('WORKER_IDENTITY_PROJECTION_CORRUPT');
    }
    return Object.freeze({ eventCount: rows.length, headDigest: previous, registrations: latest.size });
  }
  #appendWorkerIdentityEvent(kind, workerId, bindingId, payload) {
    const meta = this.#leaseDb.prepare(
      'SELECT event_count AS eventCount,head_digest AS headDigest FROM worker_identity_meta WHERE singleton=1'
    ).get();
    if (!meta || meta.eventCount >= WORKER_IDENTITY_MAX_EVENTS) fail('WORKER_IDENTITY_JOURNAL_LIMIT');
    const at = new Date().toISOString();
    const event = { schema:1, kind, workerId, bindingId, ...payload, at };
    const body = canonical(event);
    const digest = hash(meta.headDigest + '\n' + body);
    const inserted = this.#leaseDb.prepare(
      'INSERT INTO worker_identity_events(worker_id,binding_id,kind,body,previous_digest,digest,created_at) VALUES(?,?,?,?,?,?,?)'
    ).run(workerId,bindingId,kind,body,meta.headDigest,digest,at);
    const seq = Number(inserted.lastInsertRowid);
    if (!Number.isSafeInteger(seq) || seq < 1) fail('WORKER_IDENTITY_JOURNAL_APPEND_FAILED');
    this.#leaseDb.prepare(
      'UPDATE worker_identity_meta SET event_count=?,head_digest=? WHERE singleton=1'
    ).run(meta.eventCount + 1,digest);
    return seq;
  }
  workerIdentityGet(workerId) {
    if (typeof workerId !== 'string' || !WORKER_ID_RE.test(workerId)) fail('WORKER_IDENTITY_REGISTRY_ID_INVALID');
    return this.#leaseReadTransaction(() => {
      this.#verifyWorkerIdentityJournal();
      const row = this.#leaseDb.prepare(
        'SELECT envelope FROM worker_identity_registry WHERE worker_id=?'
      ).get(workerId);
      return row ? JSON.parse(row.envelope) : null;
    });
  }
  workerIdentityIsRevoked(workerId, bindingId) {
    if (typeof workerId !== 'string' || !WORKER_ID_RE.test(workerId)
      || typeof bindingId !== 'string' || !WORKER_BINDING_RE.test(bindingId))
      fail('WORKER_IDENTITY_REGISTRY_ID_INVALID');
    return this.#leaseReadTransaction(() => {
      this.#verifyWorkerIdentityJournal();
      return Boolean(this.#leaseDb.prepare(
        "SELECT 1 AS found FROM worker_identity_events WHERE worker_id=? AND binding_id=? AND kind='REVOKED' LIMIT 1"
      ).get(workerId,bindingId));
    });
  }
  workerIdentityRegister(envelope, options = {}) {
    const record = workerIdentityEnvelope(envelope);
    const opts = workerIdentityOptions(options,
      ['expectedPreviousBindingId','expectedPreviousState'],
      {expectedPreviousBindingId:null,expectedPreviousState:'EMPTY'},
      'WORKER_IDENTITY_REGISTRY_CAS_INVALID');
    const {expectedPreviousBindingId,expectedPreviousState}=opts;
    const now=Date.now();
    if (record.expiresAtMs <= now || record.envelope.claims.issuedAtMs > now)
      fail('WORKER_IDENTITY_ENVELOPE_EXPIRED');
    if (!['EMPTY','REVOKED','EXPIRED'].includes(expectedPreviousState)
      || (expectedPreviousState === 'EMPTY'
        ? expectedPreviousBindingId !== null
        : typeof expectedPreviousBindingId !== 'string' || !WORKER_BINDING_RE.test(expectedPreviousBindingId)))
      fail('WORKER_IDENTITY_REGISTRY_CAS_INVALID');
    return this.#leaseTransaction(() => {
      this.#verifyWorkerIdentityJournal();
      const old = this.#leaseDb.prepare(
        'SELECT binding_id AS bindingId,state,envelope FROM worker_identity_registry WHERE worker_id=?'
      ).get(record.workerId);
      if (!old) {
        if (expectedPreviousState !== 'EMPTY' || expectedPreviousBindingId !== null) return false;
      } else {
        const prior = workerIdentityEnvelope(JSON.parse(old.envelope));
        const state = old.state === 'REVOKED' ? 'REVOKED'
          : prior.expiresAtMs <= now ? 'EXPIRED' : 'ACTIVE';
        if (old.bindingId !== expectedPreviousBindingId || state !== expectedPreviousState
          || prior.bindingId === record.bindingId) return false;
      }
      const eventSeq = this.#appendWorkerIdentityEvent('REGISTERED',record.workerId,record.bindingId,{
        envelope:record.envelope
      });
      this.#leaseDb.prepare(
        "INSERT INTO worker_identity_registry(worker_id,binding_id,signature,envelope,state,event_seq) " +
        "VALUES(?,?,?,?, 'ACTIVE',?) ON CONFLICT(worker_id) DO UPDATE SET binding_id=excluded.binding_id," +
        "signature=excluded.signature,envelope=excluded.envelope,state='ACTIVE',event_seq=excluded.event_seq"
      ).run(record.workerId,record.bindingId,record.signature,record.text,eventSeq);
      this.#verifyWorkerIdentityJournal();
      return true;
    });
  }
  workerIdentityRevoke(workerId, bindingId, receipt, options = {}) {
    const opts=workerIdentityOptions(options,['expectedSignature'],{expectedSignature:undefined},
      'WORKER_IDENTITY_REGISTRY_REVOCATION_INVALID');
    const expectedSignature=opts.expectedSignature;
    let safeReceipt;
    try { safeReceipt=workerIdentityJson(receipt); }
    catch { fail('WORKER_IDENTITY_REGISTRY_REVOCATION_INVALID'); }
    if (typeof workerId !== 'string' || !WORKER_ID_RE.test(workerId)
      || typeof bindingId !== 'string' || !WORKER_BINDING_RE.test(bindingId)
      || typeof expectedSignature !== 'string' || !WORKER_B64URL_RE.test(expectedSignature)
      || Buffer.from(expectedSignature,'base64url').length!==64
      || Buffer.from(expectedSignature,'base64url').toString('base64url')!==expectedSignature
      || !safeReceipt || Object.getPrototypeOf(safeReceipt) !== Object.prototype
      || Object.keys(safeReceipt).sort().join(',') !== ['reasonCode','revocationId','revokedAtMs'].sort().join(',')
      || typeof safeReceipt.reasonCode !== 'string' || !WORKER_SAFE_ID_RE.test(safeReceipt.reasonCode)
      || typeof safeReceipt.revocationId !== 'string' || !WORKER_REVOCATION_UUID_RE.test(safeReceipt.revocationId)
      || !Number.isSafeInteger(safeReceipt.revokedAtMs) || safeReceipt.revokedAtMs < 0
      || safeReceipt.revokedAtMs > Date.now() + 5000)
      fail('WORKER_IDENTITY_REGISTRY_REVOCATION_INVALID');
    const receiptText = canonical(safeReceipt);
    if (Buffer.byteLength(receiptText) > 2048) fail('WORKER_IDENTITY_REGISTRY_REVOCATION_INVALID');
    return this.#leaseTransaction(() => {
      this.#verifyWorkerIdentityJournal();
      const current = this.#leaseDb.prepare(
        'SELECT binding_id AS bindingId,signature,state FROM worker_identity_registry WHERE worker_id=?'
      ).get(workerId);
      if (!current || current.bindingId !== bindingId || current.signature !== expectedSignature
        || current.state !== 'ACTIVE') return false;
      const eventSeq = this.#appendWorkerIdentityEvent('REVOKED',workerId,bindingId,{
        expectedSignature,receipt:JSON.parse(receiptText)
      });
      this.#leaseDb.prepare(
        "UPDATE worker_identity_registry SET state='REVOKED',event_seq=? WHERE worker_id=? AND binding_id=? AND signature=? AND state='ACTIVE'"
      ).run(eventSeq,workerId,bindingId,expectedSignature);
      this.#verifyWorkerIdentityJournal();
      return true;
    });
  }
  workerIdentityJournalStatus() {
    return this.#leaseReadTransaction(() => this.#verifyWorkerIdentityJournal());
  }
  #acquireRootLease(root, workflow, owner, expiresAt, revisionValue) {
    if (this.#schedulerPolicy.oneWriterPerRoot === false) return null;
    const key=leaseRootKey(root), now=new Date().toISOString();
    return this.#leaseTransaction(() => {
      // An expired lease does not prove that the previous external effect has ceased.
      // Preserve the fencing token and require independent reconciliation.
      const lease=this.#leaseDb.prepare('SELECT profile,workflow,owner,expires_at,fencing_token FROM root_leases WHERE root=?').get(key);
      if (lease) fail(lease.expires_at<=now
        ? 'WORKFLOW_ROOT_LEASE_EXPIRED_RECONCILIATION_REQUIRED'
        : 'WORKFLOW_ROOT_LEASED');
      this.#leaseDb.prepare('INSERT INTO root_lease_counters(root,last_token) VALUES(?,0) ON CONFLICT(root) DO NOTHING').run(key);
      const counter=this.#leaseDb.prepare('SELECT last_token FROM root_lease_counters WHERE root=?').get(key);
      if(!counter||!Number.isSafeInteger(counter.last_token)||counter.last_token>=Number.MAX_SAFE_INTEGER)
        fail('WORKFLOW_ROOT_FENCE_EXHAUSTED');
      const fencingToken=counter.last_token+1;
      const increment=this.#leaseDb.prepare('UPDATE root_lease_counters SET last_token=? WHERE root=? AND last_token=?')
        .run(fencingToken,key,counter.last_token);
      if(increment.changes!==1)fail('WORKFLOW_ROOT_FENCE_CONFLICT');
      this.#leaseDb.prepare('INSERT INTO root_leases(root,profile,workflow,owner,expires_at,revision,fencing_token) VALUES(?,?,?,?,?,?,?)')
        .run(key,this.#profileId,workflow,owner,expiresAt,revisionValue,fencingToken);
      return fencingToken;
    });
  }
  #assertRootLease(root, workflow, owner, fencingToken, workflowScope = null) {
    if (this.#schedulerPolicy.oneWriterPerRoot === false) return true;
    const row=this.#leaseDb.prepare('SELECT profile,workflow,owner,revision,fencing_token FROM root_leases WHERE root=? AND profile=? AND workflow=? AND owner=? AND fencing_token=? AND expires_at>?')
      .get(leaseRootKey(root),this.#profileId,workflow,owner,fencingToken,new Date().toISOString());
    if(!row)fail('WORKFLOW_ROOT_LEASE_LOST');
    if(workflowScope!==null){
      const expectedLeaseId=hash(canonical({
        root:leaseRootKey(root),profile:row.profile,workflow:row.workflow,
        owner:row.owner,revision:row.revision,fencingToken:row.fencing_token
      }));
      const expectedRootFingerprint=hash(canonical({
        device:this.#device,root:rootWithin(root,this.#roots)
      }));
      if(workflowScope.workflowId!==workflow
        ||typeof workflowScope.stepId!=='string'||!ID.test(workflowScope.stepId)
        ||!owner.endsWith(':'+workflowScope.operationId)
        ||workflowScope.revision!==row.revision
        ||workflowScope.leaseId!==expectedLeaseId
        ||workflowScope.rootFingerprint!==expectedRootFingerprint
        ||workflowScope.fencingToken!==row.fencing_token)
        fail('WORKFLOW_ROOT_LEASE_IDENTITY_MISMATCH');
    }
    return true;
  }
  #renewRootLease(root, workflow, owner, expiresAt, fencingToken) {
    if (this.#schedulerPolicy.oneWriterPerRoot === false) return true;
    const result=this.#leaseDb.prepare('UPDATE root_leases SET expires_at=? WHERE root=? AND profile=? AND workflow=? AND owner=? AND fencing_token=? AND expires_at>?')
      .run(expiresAt,leaseRootKey(root),this.#profileId,workflow,owner,fencingToken,new Date().toISOString());
    if(result.changes!==1)fail('WORKFLOW_ROOT_LEASE_LOST');
    return true;
  }
  #releaseRootLease(root, workflow, owner, fencingToken) {
    if (this.#schedulerPolicy.oneWriterPerRoot === false) return;
    this.#leaseDb.prepare('DELETE FROM root_leases WHERE root=? AND profile=? AND workflow=? AND owner=? AND fencing_token=?')
      .run(leaseRootKey(root),this.#profileId,workflow,owner,fencingToken);
  }
  #reconciliationLeaseRow(root, workflow, step, { allowMissing = false, requireExpired = true } = {}) {
    if (this.#schedulerPolicy.oneWriterPerRoot === false) return null;
    if (typeof step.operationId !== 'string' || !Number.isSafeInteger(step.leaseRevision)
      || !Number.isSafeInteger(step.fencingToken) || step.fencingToken < 1) {
      fail('WORKFLOW_LEASE_RECONCILIATION_IDENTITY_MISSING');
    }
    const row=this.#leaseDb.prepare('SELECT profile,workflow,owner,expires_at,revision,fencing_token FROM root_leases WHERE root=?')
      .get(leaseRootKey(root));
    if (!row) {
      if (allowMissing) return null;
      fail('WORKFLOW_ROOT_LEASE_MISSING');
    }
    if (row.profile !== this.#profileId || row.workflow !== workflow
      || row.revision !== step.leaseRevision || row.fencing_token !== step.fencingToken
      || typeof row.owner !== 'string' || !row.owner.endsWith(':' + step.operationId)) {
      fail('WORKFLOW_ROOT_LEASE_IDENTITY_MISMATCH');
    }
    const expectedLeaseId=hash(canonical({
      root:leaseRootKey(root),profile:row.profile,workflow:row.workflow,
      owner:row.owner,revision:row.revision,fencingToken:row.fencing_token
    }));
    const expectedRootFingerprint=hash(canonical({device:this.#device,root:rootWithin(root,this.#roots)}));
    if (step.leaseId !== expectedLeaseId || step.rootFingerprint !== expectedRootFingerprint) {
      fail('WORKFLOW_ROOT_LEASE_IDENTITY_MISMATCH');
    }
    // Process-capable operations require expiry plus an independently verified
    // cessation receipt. Non-process tools have already returned to this host;
    // their uncertain external state still needs reconciliation, but no child
    // process can continue holding the root.
    if (requireExpired && row.expires_at > new Date().toISOString()) fail('WORKFLOW_ROOT_LEASE_NOT_EXPIRED');
    return row;
  }
  #releaseReconciledRootLease(root, workflow, step, { requireExpired = true } = {}) {
    if (this.#schedulerPolicy.oneWriterPerRoot === false) return { status:'NOT_REQUIRED' };
    return this.#leaseTransaction(() => {
      const row=this.#reconciliationLeaseRow(root,workflow,step,{allowMissing:true,requireExpired});
      if (!row) return { status:'ALREADY_RELEASED' };
      const identity=[leaseRootKey(root),this.#profileId,workflow,row.owner,step.leaseRevision,step.fencingToken];
      const result=requireExpired
        ? this.#leaseDb.prepare('DELETE FROM root_leases WHERE root=? AND profile=? AND workflow=? AND owner=? AND revision=? AND fencing_token=? AND expires_at<=?')
          .run(...identity,new Date().toISOString())
        : this.#leaseDb.prepare('DELETE FROM root_leases WHERE root=? AND profile=? AND workflow=? AND owner=? AND revision=? AND fencing_token=?')
          .run(...identity);
      if (result.changes !== 1) {
        const current=this.#leaseDb.prepare('SELECT profile,workflow,owner,revision,fencing_token FROM root_leases WHERE root=?')
          .get(leaseRootKey(root));
        if (!current) return { status:'ALREADY_RELEASED' };
        fail('WORKFLOW_ROOT_LEASE_RELEASE_CONFLICT');
      }
      return { status:'RELEASED' };
    });
  }
  #load(id) {
    identifier(id);
    const row = this.#db.prepare('SELECT * FROM workflows WHERE id=?').get(id);
    if (!row) fail('WORKFLOW_NOT_FOUND');
    let state;
    try { state = JSON.parse(row.snapshot); } catch { fail('WORKFLOW_CORRUPT_SNAPSHOT'); }
    const events = this.#db.prepare('SELECT seq,body,digest FROM events WHERE workflow=? ORDER BY seq').all(id);
    if (!events.length || events.length > MAX_EVENTS || events.length !== row.revision) fail('WORKFLOW_CORRUPT_HISTORY');
    let prev = ZERO, last;
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (event.seq !== i + 1 || hash(event.body) !== event.digest) fail('WORKFLOW_CORRUPT_EVENT');
      try { last = JSON.parse(event.body); } catch { fail('WORKFLOW_CORRUPT_EVENT'); }
      if (last.schema !== 1 || last.id !== id || last.seq !== event.seq || last.previous !== prev) fail('WORKFLOW_CORRUPT_CHAIN');
      prev = event.digest;
    }
    if (row.head !== prev || state.id !== id || state.revision !== row.revision || jsonHash(state) !== last.snapshotSha256) fail('WORKFLOW_CORRUPT_SNAPSHOT');
    normalizeWorkflowState(state, { authority: this.#authority, executionProfile: this.#executionProfile, schedulerPolicy: this.#schedulerPolicy });
    if (!state.control) {
      // Recover old explicit controls from the verified journal, never from the
      // scheduler flag (which may simply have been disabled at creation).
      state.control = { intent: state.lifecycleState === 'CANCELLED' ? 'CANCELLED' : 'ACTIVE', generation: 0 };
      for (const event of events) {
        const body = JSON.parse(event.body);
        if (body.kind !== 'control') continue;
        const intent = { pause: 'PAUSED', resume: 'ACTIVE', cancel: 'CANCELLED' }[body.data?.action];
        if (intent) { state.control.intent = intent; state.control.generation++; }
      }
    }
    state.planExtensions ??= [];
    state.planPriorities ??= [];
    state.planEdits ??= [];
    return { state, head: prev, events };
  }
  #commit(state, previous, kind, data) {
    if (state.revision >= MAX_EVENTS) fail('WORKFLOW_EVENT_LIMIT');
    state.schema = 2;
    state.configSha256 = this.#configSha;
    state.revision++;
    state.updatedAt = new Date().toISOString();
    const snapshot = canonical(state);
    if (Buffer.byteLength(snapshot) > MAX_STATE) fail('WORKFLOW_STATE_LIMIT');
    const body = canonical({ schema: 1, id: state.id, seq: state.revision, at: state.updatedAt,
      previous, kind, data, snapshotSha256: hash(snapshot) });
    const digest = hash(body);
    this.#db.prepare('UPDATE workflows SET revision=?, head=?, snapshot=? WHERE id=?').run(state.revision, digest, snapshot, state.id);
    this.#db.prepare('INSERT INTO events(workflow,seq,body,digest) VALUES(?,?,?,?)').run(state.id, state.revision, body, digest);
    return { state: clone(state), headSha256: digest };
  }
  #mutate(id, expectedRevision, kind, action) {
    revision(expectedRevision);
    return this.#transaction(() => {
      const { state, head } = this.#load(id);
      if (state.revision !== expectedRevision) fail('WORKFLOW_REVISION_CONFLICT');
      const data = action(state);
      return this.#commit(state, head, kind, data);
    });
  }
  #identity(state) {
    const root = rootWithin(state.root, this.#roots);
    if (!samePath(state.root, root) || state.device !== this.#device) fail('WORKFLOW_IDENTITY_CHANGED');
    const auth = authorityCompatible(state.authority, this.#authority);
    if (!auth.ok) fail(auth.code);
  }
  create({ id, root, goal, acceptance, steps, executionProfile = undefined, brainPath = undefined, autoContinue = undefined, retryBudget = undefined }) {
    identifier(id); safeText(goal);
    root = rootWithin(root, this.#roots);
    if (!Array.isArray(acceptance) || !acceptance.length || acceptance.length > 50) fail('WORKFLOW_ACCEPTANCE_REQUIRED');
    acceptance.forEach(x => safeText(x, 2000));
    if (!Array.isArray(steps) || !steps.length || steps.length > 100) fail('WORKFLOW_STEPS_REQUIRED');
    const seen = new Set();
    const plan = steps.map((s, i) => {
      identifier(s.id); safeText(s.title, 500);
      if (seen.has(s.id)) fail('WORKFLOW_DUPLICATE_STEP');
      const deps = s.dependsOn ?? (i ? [steps[i - 1].id] : []);
      if (!Array.isArray(deps) || deps.length > 100 || deps.some(d => !seen.has(d)) || new Set(deps).size !== deps.length) fail('WORKFLOW_INVALID_DEPENDENCY');
      seen.add(s.id);
      return { id: s.id, title: s.title, dependsOn: [...deps], status: 'pending' };
    });
    const brainMarkdownPath = safeRelative(brainPath, 'PROJECT_BRAIN.md');
    return this.#transaction(() => {
      if (this.#db.prepare('SELECT id FROM workflows WHERE id=?').get(id)) fail('WORKFLOW_ALREADY_EXISTS');
      if (this.#db.prepare('SELECT COUNT(*) AS n FROM workflows').get().n >= 100000) fail('WORKFLOW_COUNT_LIMIT');
      const state = { schema: 2, id, root, device: this.#device, configSha256: this.#configSha,
        goal, acceptance, revision: 0, createdAt: new Date().toISOString(), updatedAt: null,
        steps: plan, planExtensions: [], notes: [], checkpoint: null, acceptanceStatus: 'UNVALIDATED',
        lifecycleState: 'CREATED',
        control: { intent: 'ACTIVE', generation: 0 },
        executionProfile: normalizeExecutionProfile(executionProfile ?? this.#executionProfile),
        authority: clone(this.#authority),
        scheduler: {
          enabled: autoContinue === undefined ? this.#schedulerPolicy.enabled : autoContinue === true,
          automaticContinuation: autoContinue === undefined ? this.#schedulerPolicy.enabled : autoContinue === true,
          retryBudget: Number.isSafeInteger(Number(retryBudget)) ? Math.max(0,Math.min(20,Number(retryBudget))) : this.#schedulerPolicy.retryBudget,
          repeatedFailureCount: 0, lastFailureCode: null, lastRootCauseCode: null, nextRunAt: null
        },
        finalization: { status:'UNVALIDATED', validatedAt:null, evidence:[] },
        brain: {
          markdownPath: brainMarkdownPath,
          jsonPath: 'project-brain.'+id+'.json', lastSyncedRevision:null, lastSyncSha256:null
        }
      };
      this.#db.prepare('INSERT INTO workflows(id,revision,head,snapshot) VALUES(?,0,?,?)').run(id, ZERO, '{}');
      const created = this.#commit(state, ZERO, 'created', { goal, root, steps: plan.map(s => s.id), executionProfile: state.executionProfile, authority: state.authority });
      this.#db.prepare('INSERT OR REPLACE INTO scheduler_jobs(workflow,lifecycle,enabled,next_run_at,lease_owner,lease_until,retry_count,last_failure,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, 'CREATED', state.scheduler.enabled ? 1 : 0, null, null, null, 0, null, new Date().toISOString());
      return created;
    });
  }
  get(id) {
    // Hold a coherent read snapshot across both tables while other processes write.
    this.#db.exec('BEGIN');
    try {
      const { state, head } = this.#load(id);
      this.#db.exec('COMMIT');
      return { state, headSha256: head, memoryIsUntrustedData: true, acceptanceStatus: 'UNVALIDATED' };
    } catch (e) { try { this.#db.exec('ROLLBACK'); } catch {} throw e; }
  }
  list() {
    return this.listPage({ limit: 1000 }).workflows;
  }
  listPage({ after = '', limit = 200 } = {}) {
    const bounded = Number.isSafeInteger(Number(limit)) ? Math.max(1, Math.min(1000, Number(limit))) : 200;
    if (after && (typeof after !== 'string' || !ID.test(after))) fail('WORKFLOW_INVALID_ID');
    const rows = this.#db.prepare("SELECT w.id,w.revision,COALESCE(s.lifecycle,'CREATED') AS lifecycle,COALESCE(s.enabled,0) AS schedulerEnabled,s.last_failure AS lastFailure FROM workflows w LEFT JOIN scheduler_jobs s ON s.workflow=w.id WHERE (?='' OR w.id>?) ORDER BY w.id LIMIT ?").all(after, after, bounded + 1);
    const hasMore = rows.length > bounded;
    const page = rows.slice(0, bounded).map(x=>({...x,schedulerEnabled:x.schedulerEnabled===1}));
    return { workflows: page, nextAfter: hasMore ? page.at(-1)?.id ?? null : null, hasMore };
  }
  schedulerBatch({ after = '', limit = 25, includeDisabled = false } = {}) {
    const bounded = Number.isSafeInteger(Number(limit)) ? Math.max(1, Math.min(100, Number(limit))) : 25;
    const include = includeDisabled === true ? 1 : 0;
    const query = "SELECT w.id,w.revision,s.lifecycle,COALESCE(s.enabled,0) AS schedulerEnabled,s.last_failure AS lastFailure FROM scheduler_jobs s JOIN workflows w ON w.id=s.workflow WHERE (?=1 OR s.enabled=1) AND s.lifecycle NOT IN ('COMPLETED','FAILED','CANCELLED') AND (?='' OR w.id>?) ORDER BY w.id LIMIT ?";
    let rows = this.#db.prepare(query).all(include, after, after, bounded);
    if (rows.length < bounded && after) {
      const remaining = bounded - rows.length;
      const wrap = this.#db.prepare("SELECT w.id,w.revision,s.lifecycle,COALESCE(s.enabled,0) AS schedulerEnabled,s.last_failure AS lastFailure FROM scheduler_jobs s JOIN workflows w ON w.id=s.workflow WHERE (?=1 OR s.enabled=1) AND s.lifecycle NOT IN ('COMPLETED','FAILED','CANCELLED') AND w.id<=? ORDER BY w.id LIMIT ?").all(include, after, remaining);
      rows = rows.concat(wrap);
    }
    const workflows = rows.map(x=>({...x,schedulerEnabled:x.schedulerEnabled===1}));
    return { workflows, nextAfter: workflows.at(-1)?.id ?? '' };
  }
  note({ id, expectedRevision, kind, text, status = 'UNVERIFIED', confidence = null, source = 'caller', reuseTargets = [], path: evidencePath = null, hash: evidenceHash = null }) {
    const kinds = ['fact','inference','proposal','assumption','decision','failure','root_cause','evidence','handoff'];
    const statuses = ['CONFIRMED','PROBABLE','UNVERIFIED','MISSING','CONTRADICTORY'];
    if (!kinds.includes(kind)) fail('WORKFLOW_NOTE_KIND');
    if (!statuses.includes(status)) fail('WORKFLOW_NOTE_STATUS');
    safeText(text);
    if (source !== 'caller') safeText(source, 500);
    if (!Array.isArray(reuseTargets) || reuseTargets.length > 20) fail('WORKFLOW_NOTE_REUSE_TARGETS');
    reuseTargets.forEach(x=>safeText(x,500));
    if (evidencePath !== null) safeText(evidencePath,512);
    if (evidenceHash !== null && !/^[a-f0-9]{64}$/.test(evidenceHash)) fail('WORKFLOW_NOTE_HASH');
    return this.#mutate(id, expectedRevision, 'note', s => {
      this.#identity(s);
      if (s.notes.length >= 500) fail('WORKFLOW_NOTE_LIMIT');
      const note = { kind, text, source, verification: status, confidence, reuseTargets:[...reuseTargets],
        path:evidencePath, hash:evidenceHash, at: new Date().toISOString() };
      s.notes.push(note); return note;
    });
  }
  needsChat({ id, expectedRevision, eventKey, reason, summary, files = [] }) {
    if (typeof eventKey !== 'string' || !EVENT_KEY.test(eventKey)) fail('WORKFLOW_CHAT_EVENT_KEY');
    safeText(reason, 2000); safeText(summary, 4000);
    if (!Array.isArray(files) || files.length > 20 || files.some(x => typeof x !== 'string' || !x || x.length > 512)) fail('WORKFLOW_CHAT_EVIDENCE');
    const view=this.get(id); this.#identity(view.state);
    const evidence=files.length ? this.evidence(view.state.root, files) : [];
    const committed=this.#mutate(id, expectedRevision, 'needs_chat', s => {
      this.#identity(s);
      if (s.lifecycleState === 'COMPLETED') fail('WORKFLOW_ALREADY_COMPLETED');
      if (s.control.intent === 'CANCELLED' || s.lifecycleState === 'CANCELLED') fail('WORKFLOW_CANCELLED');
      if (s.pendingChatHandoff && s.pendingChatHandoff.eventKey !== eventKey) fail('WORKFLOW_CHAT_HANDOFF_ALREADY_PENDING');
      if (s.notes.length >= 500) fail('WORKFLOW_NOTE_LIMIT');
      const at=new Date().toISOString();
      const handoff={eventKey,reason,summary,evidence,createdAt:at,deliveryState:'PENDING'};
      s.notes.push({kind:'handoff',text:summary,source:'workflow_needs_chat',verification:'CONFIRMED',confidence:'HIGH',
        reuseTargets:['Project Brain','handoff'],path:null,hash:null,at,handoff:{eventKey,reason,evidence}});
      s.pendingChatHandoff=handoff;
      s.control={intent:'PAUSED',generation:s.control.generation+1};
      s.lifecycleState='WAITING';
      s.scheduler.enabled=false;
      s.scheduler.automaticContinuation=false;
      s.scheduler.lastFailureCode='NEEDS_CHAT';
      this.#db.prepare('UPDATE scheduler_jobs SET lifecycle=?,enabled=0,last_failure=?,updated_at=? WHERE workflow=?')
        .run(s.lifecycleState,'NEEDS_CHAT',at,id);
      return {eventKey,lifecycleState:s.lifecycleState,evidence};
    });
    let brainSync=null,brainError=null;
    try{brainSync=syncProjectBrain(committed.state);}catch(error){brainError=error.message;}
    return {...committed,brainSync,brainError};
  }
  pendingChatHandoffs() {
    const rows=this.#db.prepare('SELECT id,snapshot FROM workflows ORDER BY id LIMIT 1001').all();
    const items=[];
    for(const row of rows){
      let state;try{state=JSON.parse(row.snapshot);}catch{continue;}
      if(state?.pendingChatHandoff && !state.pendingChatHandoff.resolvedAt) items.push({id:row.id,revision:state.revision,handoff:clone(state.pendingChatHandoff)});
    }
    return items;
  }
  search({ id, query }) {
    safeText(query, 160);
    const { state } = this.get(id);
    const q = query.toLocaleLowerCase();
    return { id, memoryIsUntrustedData: true, matches: state.notes.filter(n => n.text.toLocaleLowerCase().includes(q)).slice(0, 30) };
  }
  evidence(root, paths) {
    root = rootWithin(root, this.#roots);
    if (!Array.isArray(paths) || !paths.length || paths.length > 20) fail('WORKFLOW_EVIDENCE_REQUIRED');
    return paths.map(relative => {
      if (typeof relative !== 'string' || !relative || relative.length > 512 || path.isAbsolute(relative) || /^[A-Za-z]:|^\\\\/.test(relative)) fail('WORKFLOW_RELATIVE_EVIDENCE_REQUIRED');
      const target = path.resolve(root, relative);
      if (!inside(root, target) || /(?:^|[\\/])(?:\.git|credentials)(?:[\\/]|$)|\.dpapi$|(?:^|[\\/])\.env(?:\.|$)/i.test(relative)) fail('WORKFLOW_EVIDENCE_OUT_OF_SCOPE');
      noLinks(target);
      if (!inside(root, fs.realpathSync.native(target))) fail('WORKFLOW_EVIDENCE_OUT_OF_SCOPE');
      const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        const a = fs.fstatSync(fd);
        if (!a.isFile() || a.size > MAX_FILE || a.nlink > 1) fail('WORKFLOW_EVIDENCE_INVALID_FILE');
        const h = createHash('sha256'), buffer = Buffer.alloc(65536);
        let bytes = 0, n;
        while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) {
          bytes += n;
          if (bytes > MAX_FILE) fail('WORKFLOW_EVIDENCE_SIZE');
          h.update(buffer.subarray(0, n));
        }
        const b = fs.fstatSync(fd);
        if (a.size !== b.size || a.mtimeMs !== b.mtimeMs || bytes !== a.size) fail('WORKFLOW_EVIDENCE_CHANGED_DURING_READ');
        return { path: path.relative(root, target), bytes, sha256: h.digest('hex') };
      } finally { fs.closeSync(fd); }
    });
  }
  resume(id) {
    const view = this.get(id), { state } = view;
    const blockers = [];
    const controlFailure = controlBlocker(state);
    if (controlFailure && controlFailure !== 'WORKFLOW_ALREADY_COMPLETED') blockers.push(controlFailure);
    try { this.#identity(state); } catch (e) { blockers.push(e.workflowCode ?? 'WORKFLOW_ROOT_UNAVAILABLE'); }
    const configDrift = state.configSha256 !== this.#configSha;
    const unresolved = state.steps.filter(s => ['running', 'uncertain'].includes(s.status));
    if (unresolved.length) blockers.push('WORKFLOW_OUTCOME_UNCERTAIN');
    if (state.lifecycleState === 'FINALIZING') blockers.push('WORKFLOW_FINALIZATION_INCOMPLETE');
    const evidence = [];
    for (const ref of state.checkpoint?.evidence ?? []) {
      try {
        const now = this.evidence(state.root, [ref.path])[0];
        const matches = now.sha256 === ref.sha256 && now.bytes === ref.bytes;
        evidence.push({ ...ref, matches });
        if (!matches) blockers.push('WORKFLOW_EVIDENCE_STALE');
      } catch { evidence.push({ ...ref, matches: false }); blockers.push('WORKFLOW_EVIDENCE_UNAVAILABLE'); }
    }
    const ready = s => s.status === 'pending' && s.dependsOn.every(d => ['recorded', 'verified', 'reconciled_applied'].includes(state.steps.find(x => x.id === d).status));
    const next = blockers.length || controlFailure ? null : state.steps.find(ready) ?? null;
    const terminalNotApplied = state.steps.some(s => s.status === 'reconciled_not_applied');
    if (terminalNotApplied && !next) blockers.push('WORKFLOW_REPLAN_REQUIRED');
    const schedulingEnabled = !controlFailure && this.#schedulerPolicy.enabled && state.scheduler?.enabled === true;
    const derivedState = controlFailure === 'WORKFLOW_CANCELLED' ? 'CANCELLED'
      : controlFailure === 'WORKFLOW_PAUSED' ? 'WAITING'
      : controlFailure === 'WORKFLOW_ALREADY_COMPLETED' ? 'COMPLETED'
      : blockers.length ? (unresolved.length ? 'INTERRUPTED' : 'BLOCKED')
      : next ? 'RESUMING' : (state.lifecycleState === 'COMPLETED' ? 'COMPLETED' : 'WAITING');
    return { ...view, blockers: [...new Set(blockers)], unresolved: unresolved.map(s => s.id), evidence,
      readyForNextStep: blockers.length === 0 && !!next, nextStep: next?.id ?? null,
      nextAction: state.checkpoint?.nextAction ?? (next ? next.title : 'Inspect the project and plan before taking the next step.'),
      automaticReplay: false, automaticContinuation: schedulingEnabled, schedulingEnabled,
      lifecycleState: derivedState, persistedLifecycleState: state.lifecycleState,
      configDrift, currentConfigSha256: this.#configSha,
      executionProfile: clone(state.executionProfile), modelProfileRequested: clone(state.executionProfile),
      acceptanceStatus: state.acceptanceStatus ?? 'UNVALIDATED' };
  }
  async call({ id, stepId, expectedRevision, tool, arguments: args = {} }, { dispatch, validate }) {
    identifier(stepId); safeText(tool, 128);
    if (typeof dispatch !== 'function' || typeof validate !== 'function') fail('WORKFLOW_HOST_DISPATCH_REQUIRED');
    const argsRaw = canonical(args);
    if (Buffer.byteLength(argsRaw) > 256 * 1024) fail('WORKFLOW_ARGUMENT_LIMIT');
    const view = this.get(id), { state } = view; this.#identity(state);
    requireActive(state);
    const fingerprint = jsonHash({ tool, args, root: state.root, device: state.device, authority: state.authority });
    const prior = state.steps.find(s => s.id === stepId);
    if (!prior) fail('WORKFLOW_STEP_NOT_FOUND');
    if (prior.callHash === fingerprint && ['recorded', 'verified', 'reconciled_applied'].includes(prior.status)) {
      return { replayed: false, cachedReceipt: true, receipt: prior.receipt ?? null, revision: state.revision };
    }
    if (prior.status !== 'pending') fail('WORKFLOW_OUTCOME_REQUIRES_RECONCILIATION');
    const gate = this.resume(id);
    if (gate.blockers.length) fail('WORKFLOW_RESUME_BLOCKED');
    await validate(tool, args, clone(state));

    const classification = classifyTool(tool,args);
    const verification = reconciliationPlan(tool,args);
    const inputHash = hash(argsRaw);
    const operationId = randomUUID(), attemptId = randomUUID();
    const idempotencyKey = hash(canonical({ workflowId:id, stepId, tool, inputHash }));
    const owner = this.#workerId + ':' + operationId;
    const now = new Date().toISOString();
    const expires = new Date(Date.now()+Math.max(this.#schedulerPolicy.leaseMs,30000)).toISOString();

    const fencingToken=this.#acquireRootLease(state.root,id,owner,expires,expectedRevision);
    const workflowScope=fencingToken===null?null:Object.freeze({
      workflowId:id,stepId,operationId,
      rootFingerprint:hash(canonical({device:this.#device,root:rootWithin(state.root,this.#roots)})),
      revision:expectedRevision,
      leaseId:hash(canonical({
        root:leaseRootKey(state.root),profile:this.#profileId,workflow:id,
        owner,revision:expectedRevision,fencingToken
      })),
      fencingToken
    });
    let prepared;
    try {
      prepared = this.#mutate(id, expectedRevision, 'intent', s => {
      this.#identity(s);
      requireActive(s);
      if (s.steps.some(x => ['running', 'uncertain'].includes(x.status))) fail('WORKFLOW_BUSY_OR_UNCERTAIN');
      const step = s.steps.find(x => x.id === stepId);
      if (!step || step.status !== 'pending') fail('WORKFLOW_STEP_NOT_PENDING');
      if (step.dependsOn.some(d => !['recorded','verified','reconciled_applied'].includes(s.steps.find(x => x.id === d).status))) fail('WORKFLOW_DEPENDENCY_NOT_READY');

      this.#db.prepare('INSERT INTO operations(operation_id,workflow,step_id,attempt_id,idempotency_key,classification,status,tool,input_hash,verification,pre_state_hash,result_status,exit_code,post_state_hash,receipt,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(operationId,id,stepId,attemptId,idempotencyKey,classification,'PREPARED',tool,inputHash,JSON.stringify(verification),
          view.headSha256,null,null,null,null,now,now);

      Object.assign(step, {
        status:'running', tool, callHash:fingerprint, operationId, attemptId, idempotencyKey,
        classification, inputHash, instance:this.#instance, ownerPid:process.pid, ownerHost:os.hostname(), startedAt:now,
        ...(workflowScope===null?{}:{
          leaseRevision:expectedRevision,fencingToken,
          leaseId:workflowScope.leaseId,rootFingerprint:workflowScope.rootFingerprint,
          workflowScope:clone(workflowScope)
        })
      });
      s.lifecycleState='RUNNING';
      return { stepId, tool, callHash:fingerprint, operationId, attemptId, idempotencyKey,
        classification, inputHash, preStateHash:view.headSha256, operationStatus:'PREPARED', rawArgumentsStored:false,
        ...(fencingToken===null?{}:{fencingToken}) };
      });
    } catch (error) {
      try { this.#releaseRootLease(state.root,id,owner,fencingToken); } catch {}
      throw error;
    }

    this.#db.prepare("UPDATE operations SET status='EXECUTING',updated_at=? WHERE operation_id=?").run(new Date().toISOString(),operationId);
    this.#db.prepare("UPDATE scheduler_jobs SET lifecycle='RUNNING',lease_owner=?,lease_until=?,updated_at=? WHERE workflow=?")
      .run(owner,expires,new Date().toISOString(),id);

    let leaseLost=false;
    let renew = setInterval(() => {
      const until = new Date(Date.now()+Math.max(this.#schedulerPolicy.leaseMs,30000)).toISOString();
      try {
        this.#renewRootLease(state.root,id,owner,until,fencingToken);
      } catch {
        leaseLost=true; /* stale completion is recorded as UNCERTAIN below */
        return;
      }
      try {
        this.#db.prepare('UPDATE scheduler_jobs SET lease_until=?,updated_at=? WHERE workflow=? AND lease_owner=?')
          .run(until,new Date().toISOString(),id,owner);
      } catch { /* scheduler projection failure does not invalidate the authoritative root lease */ }
    }, Math.max(2000,Math.floor(Math.max(this.#schedulerPolicy.leaseMs,30000)/3)));
    renew.unref?.();

    let result, receipt, failure = false, finished = null, dispatchStarted=false, nativeCessationPending=false;
    try {
      try {
        if(fencingToken!==null) {
          if(leaseLost)fail('WORKFLOW_ROOT_LEASE_LOST');
          this.#assertRootLease(state.root,id,owner,fencingToken,workflowScope);
        }
        dispatchStarted=true;
        result = await dispatch(tool, args, clone(prepared.state), workflowScope);
        receipt = receiptFields(result);
        failure = badResult(result);
        if (nativeReceiptIdentityMismatch(result, operationId)) {
          failure = true; receipt.errorCode='WORKFLOW_NATIVE_RECEIPT_IDENTITY_MISMATCH';
        } else if (deferredEffect(result)) receipt.errorCode='WORKFLOW_DEFERRED_EFFECT_UNVERIFIED';
        else if (terminalEffectFailure(result) || nestedOperationFailure(result)) receipt.errorCode='WORKFLOW_EFFECT_COMPLETION_UNVERIFIED';
        const cessationRequired = this.#schedulerPolicy.oneWriterPerRoot !== false
          && nativeExecutionNeedsCessationProof(result, tool);
        if (cessationRequired) {
          const proof = result?.processCessationProof ?? result?.result?.processCessationProof ?? null;
          if (workflowScope && isTrustedProcessCessationProof(proof,workflowScope)) {
            const serialized = serializeProcessCessationProof(proof);
            if (serialized) receipt.processCessationProof = serialized;
            else {
              failure = true;
              nativeCessationPending = true;
              receipt.nativeCessationProofRequired = true;
              receipt.errorCode ??= 'WORKFLOW_NATIVE_CESSATION_PROOF_INVALID';
            }
          } else {
            failure = true;
            nativeCessationPending = true;
            receipt.nativeCessationProofRequired = true;
            receipt.errorCode ??= 'WORKFLOW_NATIVE_CESSATION_PROOF_MISSING_OR_UNTRUSTED';
          }
        }
      }
      catch (e) {
        failure = true;
        receipt = {
          exception:true,
          errorCode:/^[A-Z][A-Z0-9_]{1,79}$/.test(e.workflowCode ?? '') ? e.workflowCode : 'TOOL_EXCEPTION',
          outputStored:false,
          ...(dispatchStarted?{}:{notDispatched:true})
        };
        if (this.#schedulerPolicy.oneWriterPerRoot !== false && nativeExecutionNeedsCessationProof(null, tool)
          && dispatchStarted) {
          nativeCessationPending = true;
          receipt.nativeCessationProofRequired = true;
          receipt.errorCode ??= 'WORKFLOW_NATIVE_CESSATION_PROOF_MISSING';
        }
      }
      if(fencingToken!==null) {
        try {
          if(leaseLost)fail('WORKFLOW_ROOT_LEASE_LOST');
          this.#assertRootLease(state.root,id,owner,fencingToken,workflowScope);
        } catch (error) {
          failure=true;
          const errorCode=error?.workflowCode==='WORKFLOW_ROOT_LEASE_IDENTITY_MISMATCH'
            ? error.workflowCode : 'WORKFLOW_ROOT_LEASE_LOST';
          receipt={...receipt,errorCode,leaseLost:true,notDispatched:!dispatchStarted,fencingToken};
        }
      }
      receipt = { ...receipt, operationId, attemptId, idempotencyKey, classification, inputHash, preStateHash:view.headSha256, postStateHash:null,
        ...(workflowScope===null?{}:{workflowScope:clone(workflowScope),fencingToken}) };
      finished = this.#transaction(() => {
        const { state:s, head } = this.#load(id), step = s.steps.find(x => x.id === stepId);
        if (step.status !== 'running' || step.operationId !== operationId || step.callHash !== fingerprint) fail('WORKFLOW_COMPLETION_CONFLICT');
        const operationStatus = failure ? 'UNCERTAIN' : (classification === 'READ_ONLY' ? 'VERIFIED' : 'EXECUTED');
        Object.assign(step, { status: failure ? 'uncertain' : (classification === 'READ_ONLY' ? 'verified' : 'recorded'), receipt, endedAt:new Date().toISOString() });
        if (failure) {
          const code=receipt.errorCode ?? 'OPERATION_UNCERTAIN';
          s.scheduler.repeatedFailureCount = s.scheduler.lastRootCauseCode === code
            ? Number(s.scheduler.repeatedFailureCount ?? 0) + 1 : 1;
          s.scheduler.lastRootCauseCode = code;
          const budget=Number.isSafeInteger(Number(s.scheduler.retryBudget)) ? Number(s.scheduler.retryBudget) : this.#schedulerPolicy.retryBudget;
          s.scheduler.lastFailureCode = s.scheduler.repeatedFailureCount > budget ? 'BLOCKED_REQUIRES_REASSESSMENT' : code;
          setLifecycle(s, s.scheduler.repeatedFailureCount > budget ? 'BLOCKED' : 'INTERRUPTED');
        } else {
          setLifecycle(s, 'RUNNING');
          s.scheduler.repeatedFailureCount=0;
          s.scheduler.lastFailureCode=null;s.scheduler.lastRootCauseCode=null;
        }
        this.#db.prepare('UPDATE operations SET status=?,result_status=?,exit_code=?,post_state_hash=?,receipt=?,updated_at=? WHERE operation_id=?')
          .run(operationStatus, failure?'UNCERTAIN':'EXECUTED',
            typeof receipt.exitCode==='number'?receipt.exitCode:null,
            (!failure && classification==='READ_ONLY')?(receipt.resultSha256??null):null,
            JSON.stringify(receipt),new Date().toISOString(),operationId);
        const committed = this.#commit(s,head,'receipt',{stepId,operationId,status:step.status,operationStatus,receipt});
        this.#db.prepare('UPDATE scheduler_jobs SET lifecycle=?,enabled=?,retry_count=?,last_failure=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE workflow=?')
          .run(s.lifecycleState,s.scheduler.enabled?1:0,Number(s.scheduler.repeatedFailureCount??0),s.scheduler.lastFailureCode,new Date().toISOString(),id);
        return committed;
      });
    } finally {
      clearInterval(renew);
      if (finished && !failure && !nativeCessationPending) {
        try { this.#releaseRootLease(state.root,id,owner,fencingToken); } catch { /* lease expiry remains the safe fallback */ }
      }
    }
    return { replayed:false,cachedReceipt:false,outcome:failure?'UNCERTAIN':'RECORDED_NOT_VALIDATED',
      revision:finished.state.revision,receipt,result:result??null,acceptanceStatus:'UNVALIDATED',
      operation:{operationId,attemptId,idempotencyKey,classification,status:failure?'UNCERTAIN':(classification==='READ_ONLY'?'VERIFIED':'EXECUTED'),
        ...(workflowScope===null?{}:{workflowScope:clone(workflowScope),fencingToken})} };
  }
  reconcile({ id, stepId, expectedRevision, outcome, files, explanation }) {
    if (!['applied', 'not_applied'].includes(outcome)) fail('WORKFLOW_RECONCILIATION_OUTCOME');
    identifier(stepId); safeText(explanation, 4000);
    const { state } = this.get(id); this.#identity(state);
    if (state.revision !== expectedRevision) fail('WORKFLOW_REVISION_CONFLICT');
    const step = state.steps.find(item => item.id === stepId);
    if (!step) fail('WORKFLOW_STEP_NOT_FOUND');
    const targetStatus = 'reconciled_' + outcome;
    const alreadyReconciled = step.status === targetStatus;
    if (step.status.startsWith('reconciled_') && !alreadyReconciled) fail('WORKFLOW_RECONCILIATION_OUTCOME_CONFLICT');
    if (!alreadyReconciled && !['running', 'uncertain'].includes(step.status)) fail('WORKFLOW_NOT_UNCERTAIN');
    if (step.status === 'running') {
      if (step.ownerHost !== os.hostname() || !Number.isSafeInteger(step.ownerPid)) fail('WORKFLOW_OWNER_UNKNOWN');
      let alive = true;
      try { process.kill(step.ownerPid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) fail('WORKFLOW_STILL_RUNNING');
    }

    const needsLeaseRelease = this.#schedulerPolicy.oneWriterPerRoot !== false;
    const processRequired = needsLeaseRelease && nativeExecutionNeedsCessationProof(step.receipt ?? null,step.tool);
    if (needsLeaseRelease) this.#reconciliationLeaseRow(state.root,id,step,{
      allowMissing:alreadyReconciled,requireExpired:processRequired
    });
    const cessationProof = step.receipt?.processCessationProof ?? step.reconciliation?.cessationProof ?? null;
    if (processRequired) {
      const expectedBinding = {
        workflowId:id, stepId, operationId:step.operationId,
        rootFingerprint:step.rootFingerprint, revision:step.leaseRevision,
        leaseId:step.leaseId, fencingToken:step.fencingToken
      };
      if (!isSerializedProcessCessationProof(cessationProof,expectedBinding)) {
        fail('WORKFLOW_CESSATION_PROOF_REQUIRED_OR_INVALID');
      }
    }

    const evidence = this.evidence(state.root,files);
    const evidenceHash = hash(canonical(evidence));
    if (alreadyReconciled) {
      if (step.reconciliation?.outcome !== outcome || step.reconciliation?.evidenceHash !== evidenceHash) {
        fail('WORKFLOW_RECONCILIATION_REPLAY_MISMATCH');
      }
      if (processRequired) {
        const saved = step.reconciliation?.cessationProof ?? step.receipt?.processCessationProof;
        if (!saved || saved.provider !== cessationProof?.provider || saved.runId !== cessationProof?.runId
          || saved.proofDigest !== cessationProof?.proofDigest || saved.operationId !== step.operationId
          || saved.leaseId !== step.leaseId || saved.fencingToken !== step.fencingToken) {
          fail('WORKFLOW_CESSATION_PROOF_REPLAY_MISMATCH');
        }
      }
      let leaseRelease = { status:'NOT_REQUIRED' };
      if (needsLeaseRelease) leaseRelease = this.#releaseReconciledRootLease(state.root,id,step,{requireExpired:processRequired});
      if (needsLeaseRelease && step.reconciliation.leaseReleaseStatus !== 'RELEASED'
        && ['RELEASED','ALREADY_RELEASED'].includes(leaseRelease.status)) {
        const updated = this.#mutate(id,expectedRevision,'lease_released',s => {
          const current=s.steps.find(item=>item.id===stepId);
          if (!current || current.status!==targetStatus || current.reconciliation?.evidenceHash!==evidenceHash) {
            fail('WORKFLOW_LEASE_RELEASE_STATE_CONFLICT');
          }
          current.reconciliation.leaseReleaseStatus='RELEASED';
          current.reconciliation.leaseReleasedAt=new Date().toISOString();
          return {stepId,operationId:current.operationId,evidenceHash,leaseReleaseStatus:'RELEASED'};
        });
        return {...updated,replayed:true,leaseRelease};
      }
      return {id,revision:state.revision,state,replayed:true,leaseRelease,reconciliation:step.reconciliation};
    }

    const committed = this.#mutate(id,expectedRevision,'reconciled',s => {
      const current=s.steps.find(item=>item.id===stepId);
      if (!current || !['running','uncertain'].includes(current.status)
        || current.operationId!==step.operationId) fail('WORKFLOW_RECONCILIATION_CONFLICT');
      current.status=targetStatus;
      current.reconciliation={
        outcome, explanation, evidence, evidenceHash,
        source:processRequired?'host-verified-process-cessation-plus-caller-attestation':'caller-attestation',
        ...(cessationProof?{cessationProof}:{}),
        leaseReleaseStatus:needsLeaseRelease?'PENDING':'NOT_REQUIRED',
        acceptance:'UNVALIDATED'
      };
      if (current.operationId) {
        this.#db.prepare('UPDATE operations SET status=?,post_state_hash=?,updated_at=? WHERE operation_id=?')
          .run(outcome==='applied'?'VERIFIED':'NOT_APPLIED',evidenceHash,new Date().toISOString(),current.operationId);
      }
      setLifecycle(s,outcome==='applied'?'RUNNING':'BLOCKED');
      s.scheduler.lastFailureCode=outcome==='applied'?null:'WORKFLOW_REPLAN_REQUIRED';
      this.#db.prepare('UPDATE scheduler_jobs SET lifecycle=?,last_failure=?,updated_at=? WHERE workflow=?')
        .run(s.lifecycleState,s.scheduler.lastFailureCode,new Date().toISOString(),id);
      return {stepId,operationId:current.operationId??null,evidenceHash,...current.reconciliation};
    });

    let leaseRelease = { status:'NOT_REQUIRED' };
    if (needsLeaseRelease) {
      try { leaseRelease=this.#releaseReconciledRootLease(state.root,id,committed.state.steps.find(item=>item.id===stepId),{requireExpired:processRequired}); }
      catch (error) {
        leaseRelease={status:'PENDING',errorCode:error?.workflowCode??'WORKFLOW_ROOT_LEASE_RELEASE_FAILED'};
      }
      if (['RELEASED','ALREADY_RELEASED'].includes(leaseRelease.status)) {
        const updated=this.#mutate(id,committed.state.revision,'lease_released',s=>{
          const current=s.steps.find(item=>item.id===stepId);
          if (!current || current.status!==targetStatus || current.reconciliation?.evidenceHash!==evidenceHash) {
            fail('WORKFLOW_LEASE_RELEASE_STATE_CONFLICT');
          }
          current.reconciliation.leaseReleaseStatus='RELEASED';
          current.reconciliation.leaseReleasedAt=new Date().toISOString();
          return {stepId,operationId:current.operationId,evidenceHash,leaseReleaseStatus:'RELEASED'};
        });
        return {...updated,revision:updated.state.revision,replayed:false,leaseRelease};
      }
    }
    return {...committed,replayed:false,leaseRelease};
  }

  async reconcileAutomatically(id, { verify }) {
    if (typeof verify !== 'function') fail('WORKFLOW_VERIFIER_REQUIRED');
    const view=this.get(id), state=view.state; this.#identity(state);
    const step=state.steps.find(x=>x.status==='uncertain' && x.operationId);
    if (!step) return { id, changed:false, reason:'NO_UNCERTAIN_OPERATION' };
    const op=this.#db.prepare('SELECT * FROM operations WHERE operation_id=? AND workflow=?').get(step.operationId,id);
    if (!op) fail('WORKFLOW_OPERATION_MISSING');
    if (['VERIFIED','NOT_APPLIED','CONFLICT'].includes(op.status)) {
      return {id,changed:false,status:op.status,reason:'RECONCILIATION_ALREADY_TERMINAL'};
    }
    let plan={strategy:'MANUAL_OR_REMOTE_STATE',classification:op.classification};
    try { if (op.verification) plan=JSON.parse(op.verification); } catch { fail('WORKFLOW_OPERATION_CORRUPT'); }
    const verdict=await verify(clone(plan),{workflowId:id,stepId:step.id,tool:op.tool,classification:op.classification,inputHash:op.input_hash});
    const status=verdict?.status;
    if (!['APPLIED','NOT_APPLIED','CONFLICT','UNAVAILABLE'].includes(status)) fail('WORKFLOW_VERIFIER_RESULT');
    if (status==='UNAVAILABLE') return {id,changed:false,status};
    const evidenceHash=/^[a-f0-9]{64}$/.test(verdict?.evidenceHash??'')?verdict.evidenceHash:null;
    const summary=typeof verdict?.summary==='string' && verdict.summary ? safeText(verdict.summary,1000) : status;
    const updated=this.#mutate(id,state.revision,'auto_reconciled',s=>{
      const current=s.steps.find(x=>x.id===step.id);
      if (!current || current.status!=='uncertain' || current.operationId!==op.operation_id) fail('WORKFLOW_RECONCILIATION_CONFLICT');
      if (status==='APPLIED') {
        current.status='reconciled_applied';
        current.reconciliation={outcome:'applied',explanation:summary,evidenceHash,source:'automatic-read-only-verification',acceptance:'UNVALIDATED'};
        setLifecycle(s, 'RESUMING');s.scheduler.lastFailureCode=null;
        this.#db.prepare("UPDATE operations SET status='VERIFIED',post_state_hash=?,updated_at=? WHERE operation_id=?").run(evidenceHash,new Date().toISOString(),op.operation_id);
      } else if (status==='NOT_APPLIED') {
        current.status='reconciled_not_applied';
        current.reconciliation={outcome:'not_applied',explanation:summary,evidenceHash,source:'automatic-read-only-verification',acceptance:'UNVALIDATED'};
        setLifecycle(s, 'BLOCKED');s.scheduler.lastFailureCode='WORKFLOW_REPLAN_REQUIRED';
        this.#db.prepare("UPDATE operations SET status='NOT_APPLIED',post_state_hash=?,updated_at=? WHERE operation_id=?").run(evidenceHash,new Date().toISOString(),op.operation_id);
      } else {
        current.reconciliation={outcome:'conflict',explanation:summary,evidenceHash,source:'automatic-read-only-verification',acceptance:'UNVALIDATED'};
        setLifecycle(s, 'BLOCKED');s.scheduler.lastFailureCode='WORKFLOW_RECONCILIATION_CONFLICT';
        this.#db.prepare("UPDATE operations SET status='CONFLICT',post_state_hash=?,updated_at=? WHERE operation_id=?").run(evidenceHash,new Date().toISOString(),op.operation_id);
      }
      this.#db.prepare('UPDATE scheduler_jobs SET lifecycle=?,last_failure=?,updated_at=? WHERE workflow=?')
        .run(s.lifecycleState,s.scheduler.lastFailureCode,new Date().toISOString(),id);
      return {stepId:current.id,operationId:op.operation_id,status,evidenceHash,summary};
    });
    return {id,changed:true,status,revision:updated.state.revision,state:updated.state};
  }

  checkpoint({ id, expectedRevision, files, nextAction, summary }) {
    safeText(nextAction, 2000); safeText(summary, 4000);
    const { state } = this.get(id); this.#identity(state);
    const evidence = this.evidence(state.root, files);
    const committed = this.#mutate(id, expectedRevision, 'checkpoint', s => {
      this.#identity(s);
      s.checkpoint = { evidence, nextAction, summary, at: new Date().toISOString(), revision: expectedRevision + 1 };
      if (s.lifecycleState !== 'COMPLETED') {
        setLifecycle(s, 'WAITING');
        this.#db.prepare('UPDATE scheduler_jobs SET lifecycle=?,enabled=?,next_run_at=?,updated_at=? WHERE workflow=?')
          .run(s.lifecycleState,s.scheduler.enabled?1:0,s.scheduler.nextRunAt,new Date().toISOString(),id);
      }
      return clone(s.checkpoint);
    });
    let brainSync=null, brainError=null;
    try { brainSync=syncProjectBrain(committed.state); }
    catch(e) { brainError=e.message; }
    return {...committed,brainSync,brainError};
  }

  finalize({ id, expectedRevision, acceptanceResults, files, summary, expectedEvidence = undefined }) {
    revision(expectedRevision);
    safeText(summary,4000);
    const initial=this.get(id), state=initial.state; this.#identity(state);
    requireActive(state);
    if (state.revision !== expectedRevision) fail('WORKFLOW_REVISION_CONFLICT');
    if (!Array.isArray(acceptanceResults) || acceptanceResults.length !== state.acceptance.length || acceptanceResults.some(x=>x!==true)) {
      fail('WORKFLOW_ACCEPTANCE_UNPROVEN');
    }
    const incomplete=state.steps.filter(s=>!['recorded','verified','reconciled_applied'].includes(s.status));
    if (incomplete.length) fail('WORKFLOW_STEPS_INCOMPLETE');
    const evidence=this.evidence(state.root,files);
    requireExpectedEvidence(evidence, expectedEvidence);
    let finalizing;
    if (state.lifecycleState === 'FINALIZING') {
      if (state.finalization?.status !== 'VALIDATING') fail('WORKFLOW_FINALIZATION_STATE');
      finalizing={state,headSha256:initial.headSha256};
    } else {
      finalizing=this.#mutate(id,expectedRevision,'finalization_started',s=>{
        requireActive(s);
        s.lifecycleState='FINALIZING';s.acceptanceStatus='VALIDATING';
        s.finalization={status:'VALIDATING',validatedAt:null,evidence,summary,acceptanceResults:[...acceptanceResults]};
        this.#db.prepare("UPDATE scheduler_jobs SET lifecycle='FINALIZING',updated_at=? WHERE workflow=?").run(new Date().toISOString(),id);
        return {acceptanceResults:[...acceptanceResults],evidence,summary};
      });
    }
    const prospective=clone(finalizing.state);
    prospective.lifecycleState='COMPLETED';prospective.acceptanceStatus='PASS';
    prospective.finalization={...prospective.finalization,evidence,summary,acceptanceResults:[...acceptanceResults],status:'PASS',validatedAt:new Date().toISOString()};
    prospective.revision=finalizing.state.revision+1;prospective.updatedAt=new Date().toISOString();
    let brainSync;
    const done=this.#mutate(id,finalizing.state.revision,'finalized',s=>{
      requireActive(s);
      if (expectedEvidence !== undefined) requireExpectedEvidence(this.evidence(s.root, files), expectedEvidence);
      // Keep the control check and final projection under the same write claim.
      brainSync=syncProjectBrain(prospective);
      if (expectedEvidence !== undefined) requireExpectedEvidence(this.evidence(s.root, files), expectedEvidence);
      s.lifecycleState='COMPLETED';s.acceptanceStatus='PASS';
      s.finalization={...prospective.finalization,brainSync};
      s.brain.lastSyncedRevision=s.revision+1;s.brain.lastSyncSha256=brainSync.jsonSha256;
      this.#db.prepare("UPDATE scheduler_jobs SET lifecycle='COMPLETED',enabled=0,last_failure=NULL,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE workflow=?")
        .run(new Date().toISOString(),id);
      this.#db.prepare('DELETE FROM root_leases WHERE workflow=?').run(id);
      return {acceptanceStatus:'PASS',evidence,brainSync};
    });
    return {...done,brainSync,acceptanceStatus:'PASS'};
  }

  health() {
    const integrity=this.#db.prepare('PRAGMA quick_check').get().quick_check;
    const scheduler=this.schedulerStatus();
    return {
      ok:integrity==='ok',schema:STORE_SCHEMA,databaseSchemaVersion:this.#db.prepare('PRAGMA user_version').get().user_version,module:MODULE_REVISION,databaseIntegrity:integrity,
      scheduler,executionProfilePersistence:true,projectBrainIntegration:true,
      configSha256:this.#configSha,authority:clone(this.#authority)
    };
  }

  revise({ id, expectedRevision, goal, acceptance, reason }) {
    revision(expectedRevision);safeText(reason,1000);
    if (goal !== undefined) safeText(goal);
    if (acceptance !== undefined) {
      if (!Array.isArray(acceptance) || acceptance.length < 1 || acceptance.length > 50) fail('WORKFLOW_ACCEPTANCE_REQUIRED');
      acceptance.forEach(x=>safeText(x,2000));
    }
    return this.#mutate(id,expectedRevision,'revised',s=>{
      this.#identity(s);
      if (s.lifecycleState==='COMPLETED' || s.lifecycleState==='CANCELLED' || s.control.intent==='CANCELLED') fail('WORKFLOW_TERMINAL');
      const before={goal:s.goal,acceptance:[...s.acceptance]};
      if (goal !== undefined) s.goal=goal;
      if (acceptance !== undefined) s.acceptance=[...acceptance];
      s.acceptanceStatus='UNVALIDATED';
      s.finalization={status:'UNVALIDATED',validatedAt:null,evidence:[]};
      setLifecycle(s, 'WAITING');
      s.scheduler.lastFailureCode=null;s.scheduler.lastRootCauseCode=null;s.scheduler.repeatedFailureCount=0;
      this.#db.prepare("UPDATE scheduler_jobs SET lifecycle='WAITING',retry_count=0,last_failure=NULL,updated_at=? WHERE workflow=?")
        .run(new Date().toISOString(),id);
      return {reason,before,after:{goal:s.goal,acceptance:[...s.acceptance]}};
    });
  }

  extendPlan(input) {
    planRecord(input, ['id','expectedRevision','operationId','targetStepId','steps','reason'],
      ['id','expectedRevision','operationId','targetStepId','steps','reason']);
    const { id, expectedRevision, operationId, targetStepId, steps, reason } = input;
    identifier(id); identifier(targetStepId); revision(expectedRevision); safeText(reason, 1000);
    if (expectedRevision < 1 || expectedRevision > MAX_EVENTS) fail('WORKFLOW_REVISION_REQUIRED');
    if (typeof operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId)) fail('WORKFLOW_PLAN_OPERATION_ID');
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > 20) fail('WORKFLOW_PLAN_STEP_LIMIT');
    planArray(steps);
    for (const step of steps) {
      planRecord(step, ['id','title','dependsOn'], ['id','title']);
      identifier(step.id); safeText(step.title, 500);
      if (Object.hasOwn(step, 'dependsOn')) {
        if (!Array.isArray(step.dependsOn) || step.dependsOn.length > 100) fail('WORKFLOW_INVALID_DEPENDENCY');
        planArray(step.dependsOn);
        for (const dependency of step.dependsOn) identifier(dependency);
        if (new Set(step.dependsOn).size !== step.dependsOn.length) fail('WORKFLOW_INVALID_DEPENDENCY');
      }
    }
    // Hash the exact request before default dependencies are filled in. A
    // receipt is immutable even when the caller later reads a newer revision.
    const payloadHash = jsonHash({ targetStepId, steps, reason });
    return this.#transaction(() => {
      const { state, head } = this.#load(id);
      this.#identity(state);
      const prior = state.planExtensions.find(item => item.operationId === operationId);
      if (prior) {
        if (prior.payloadHash !== payloadHash) fail('WORKFLOW_PLAN_OPERATION_CONFLICT');
        if (expectedRevision !== prior.sourceRevision && expectedRevision !== state.revision) fail('WORKFLOW_REVISION_CONFLICT');
        return { state: clone(state), receipt: clone(prior), cachedReceipt: true };
      }
      if (state.revision !== expectedRevision) fail('WORKFLOW_REVISION_CONFLICT');
      requireActive(state);
      if (['FAILED','FINALIZING','VALIDATING'].includes(state.lifecycleState)) fail('WORKFLOW_PLAN_STATE_BLOCKED');
      if (state.steps.some(step => ['running','uncertain'].includes(step.status))
        || this.#db.prepare("SELECT 1 FROM operations WHERE workflow=? AND status IN ('PREPARED','EXECUTING','UNCERTAIN') LIMIT 1").get(id)) {
        fail('WORKFLOW_BUSY_OR_UNCERTAIN');
      }
      if (state.steps.length + steps.length > 100 || state.planExtensions.length >= 99) fail('WORKFLOW_PLAN_STEP_LIMIT');
      requireOrderedPlan(state.steps);
      const targetIndex = state.steps.findIndex(step => step.id === targetStepId);
      if (targetIndex < 0) fail('WORKFLOW_STEP_NOT_FOUND');
      const target = state.steps[targetIndex];
      if (target.status !== 'pending'
        || ['operationId','callHash','receipt','startedAt','endedAt','attemptId','idempotencyKey','tool','reconciliation'].some(key => Object.hasOwn(target, key))
        || this.#db.prepare('SELECT 1 FROM operations WHERE workflow=? AND step_id=? LIMIT 1').get(id, targetStepId)) {
        fail('WORKFLOW_PLAN_TARGET_NOT_PENDING');
      }
      const originals = new Map(state.steps.map(step => [step.id, step]));
      const ancestors = new Set();
      const collect = step => {
        for (const dependency of step.dependsOn) if (!ancestors.has(dependency)) {
          ancestors.add(dependency); collect(originals.get(dependency));
        }
      };
      collect(target);
      const inserted = [], added = new Set();
      for (const request of steps) {
        if (originals.has(request.id) || added.has(request.id)) fail('WORKFLOW_DUPLICATE_STEP');
        const dependsOn = request.dependsOn ?? (inserted.length ? [inserted.at(-1).id] : target.dependsOn);
        if (dependsOn.some(dependency => !ancestors.has(dependency) && !added.has(dependency))) fail('WORKFLOW_INVALID_DEPENDENCY');
        inserted.push({ id: request.id, title: request.title, dependsOn: [...dependsOn], status: 'pending' });
        added.add(request.id);
      }
      const consumed = new Set(inserted.flatMap(step => step.dependsOn));
      const terminalIds = inserted.filter(step => !consumed.has(step.id)).map(step => step.id);
      const sourcePlanHash = structuralPlanHash(state.steps);
      state.steps = [...state.steps.slice(0, targetIndex), ...inserted,
        { ...target, dependsOn: [...new Set([...target.dependsOn, ...terminalIds])] }, ...state.steps.slice(targetIndex + 1)];
      requireOrderedPlan(state.steps);
      const receipt = {
        operationId, targetStepId, sourceRevision: state.revision, resultRevision: state.revision + 1,
        addedStepIds: inserted.map(step => step.id), payloadHash,
        sourcePlanHash, resultPlanHash: structuralPlanHash(state.steps)
      };
      state.planExtensions.push(receipt);
      const committed = this.#commit(state, head, 'plan_extended', { reason, receipt });
      return { state: committed.state, receipt: clone(receipt), cachedReceipt: false };
    });
  }

  prioritizePlan(input) {
    // Explicit owner-provided complete display order. Never alter dependency
    // edges, steps with committed receipts, or any running/uncertain operation.
    planRecord(input,
      ['id','expectedRevision','operationId','orderedStepIds','reason'],
      ['id','expectedRevision','operationId','orderedStepIds','reason']);
    const { id, expectedRevision, operationId, orderedStepIds, reason } = input;
    identifier(id); revision(expectedRevision);safeText(reason,1000);
    if (typeof operationId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId))
      fail('WORKFLOW_PLAN_OPERATION_ID');
    planArray(orderedStepIds);
    if (!orderedStepIds.length || orderedStepIds.length > 100)
      fail('WORKFLOW_PLAN_STEP_LIMIT');
    for (const item of orderedStepIds) identifier(item);
    if (new Set(orderedStepIds).size !== orderedStepIds.length)
      fail('WORKFLOW_PLAN_DUPLICATE_ORDER_ID');
    const payloadHash = jsonHash({orderedStepIds,reason});
    return this.#transaction(()=>{
      const {state,head}=this.#load(id);
      this.#identity(state);
      const prior=(state.planPriorities ?? []).find(x=>x.operationId===operationId);
      if (prior) {
        if (prior.payloadHash!==payloadHash) fail('WORKFLOW_PLAN_OPERATION_CONFLICT');
        if (expectedRevision!==prior.sourceRevision &&
            expectedRevision!==state.revision) fail('WORKFLOW_REVISION_CONFLICT');
        return {state:clone(state),receipt:clone(prior),cachedReceipt:true,action:'PRIORITIZED'};
      }
      if (state.revision!==expectedRevision) fail('WORKFLOW_REVISION_CONFLICT');
      requireActive(state);
      if (['FAILED','FINALIZING','VALIDATING'].includes(state.lifecycleState))
        fail('WORKFLOW_PLAN_STATE_BLOCKED');
      if (state.steps.some(step=>['running','uncertain'].includes(step.status)) ||
          this.#db.prepare("SELECT 1 FROM operations WHERE workflow=? AND status IN ('PREPARED','EXECUTING','UNCERTAIN') LIMIT 1").get(id))
        fail('WORKFLOW_BUSY_OR_UNCERTAIN');
      requireOrderedPlan(state.steps);
      if (state.steps.length!==orderedStepIds.length ||
          state.steps.some(step=>!orderedStepIds.includes(step.id)))
        fail('WORKFLOW_PLAN_ORDER_SET_MISMATCH');
      const rows=new Map(state.steps.map(s=>[s.id,s]));
      const next=orderedStepIds.map(id=>rows.get(id));
      // Previously executed, uncertain or identity-linked slots stay fixed.
      for (let i=0;i<state.steps.length;i++){
        const step=state.steps[i];
        if (step.status!=='pending' ||
            ['operationId','callHash','receipt','startedAt','endedAt','attemptId',
             'idempotencyKey','tool','reconciliation'].some(k=>Object.hasOwn(step,k)) ||
            this.#db.prepare('SELECT 1 FROM operations WHERE workflow=? AND step_id=? LIMIT 1').get(id,step.id)) {
          if (next[i].id!==step.id) fail('WORKFLOW_PLAN_FIXED_STEP_MOVED');
        }
      }
      // A user priority cannot invert a dependency or silently replace one.
      requireOrderedPlan(next);
      const sourcePlanHash=structuralPlanHash(state.steps);
      if (state.steps.every((x,i)=>x.id===next[i].id))
        return {state:clone(state),receipt:null,cachedReceipt:false,action:'NO_OP'};
      if (state.planPriorities.length >= 99) fail('WORKFLOW_PLAN_STEP_LIMIT');
      state.steps=next;
      const receipt={
        operationId,sourceRevision:state.revision,resultRevision:state.revision+1,
        orderedStepIds:[...orderedStepIds],payloadHash,
        sourcePlanHash,resultPlanHash:structuralPlanHash(state.steps)
      };
      state.planPriorities.push(receipt);
      const committed=this.#commit(state,head,'plan_prioritized',{reason,receipt});
      return {state:committed.state,receipt:clone(receipt),
              cachedReceipt:false,action:'PRIORITIZED'};
    });
  }

  editPlanStep(input) {
    // Only rename one unexecuted, unleased step. Do not rewrite dependencies,
    // stable IDs, acceptance criteria or any already-started operation.
    planRecord(input,['id','expectedRevision','operationId','stepId','title','reason'],
      ['id','expectedRevision','operationId','stepId','title','reason']);
    const {id,expectedRevision,operationId,stepId,title,reason}=input;
    identifier(id);identifier(stepId);revision(expectedRevision);
    safeText(title,500);safeText(reason,1000);
    if (typeof operationId!=='string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId))
      fail('WORKFLOW_PLAN_OPERATION_ID');
    const payloadHash=jsonHash({stepId,title,reason});
    return this.#transaction(()=>{
      const {state,head}=this.#load(id);this.#identity(state);
      const prior=(state.planEdits??[]).find(x=>x.operationId===operationId);
      if(prior){
        if(prior.payloadHash!==payloadHash)fail('WORKFLOW_PLAN_OPERATION_CONFLICT');
        if(expectedRevision!==prior.sourceRevision &&
            expectedRevision!==state.revision)fail('WORKFLOW_REVISION_CONFLICT');
        return {state:clone(state),receipt:clone(prior),cachedReceipt:true,action:'EDITED'};
      }
      if(state.revision!==expectedRevision)fail('WORKFLOW_REVISION_CONFLICT');
      requireActive(state);
      if(['FAILED','FINALIZING','VALIDATING'].includes(state.lifecycleState))
        fail('WORKFLOW_PLAN_STATE_BLOCKED');
      if(state.steps.some(s=>['running','uncertain'].includes(s.status)) ||
          this.#db.prepare("SELECT 1 FROM operations WHERE workflow=? AND status IN ('PREPARED','EXECUTING','UNCERTAIN') LIMIT 1").get(id))
        fail('WORKFLOW_BUSY_OR_UNCERTAIN');
      const item=state.steps.find(s=>s.id===stepId);
      if(!item)fail('WORKFLOW_STEP_NOT_FOUND');
      if(item.status!=='pending' ||
          ['operationId','callHash','receipt','startedAt','endedAt','attemptId',
           'idempotencyKey','tool','reconciliation'].some(k=>Object.hasOwn(item,k)) ||
          this.#db.prepare('SELECT 1 FROM operations WHERE workflow=? AND step_id=? LIMIT 1').get(id,stepId))
        fail('WORKFLOW_PLAN_TARGET_NOT_PENDING');
      if(item.title===title)
        return {state:clone(state),receipt:null,cachedReceipt:false,action:'NO_OP'};
      if(state.planEdits.length>=99)fail('WORKFLOW_PLAN_STEP_LIMIT');
      const sourcePlanHash=structuralPlanHash(state.steps);
      const priorTitle=item.title;
      item.title=title;
      const receipt={
        operationId,stepId,sourceRevision:state.revision,resultRevision:state.revision+1,
        payloadHash,sourcePlanHash,resultPlanHash:structuralPlanHash(state.steps),
        previousTitle:priorTitle,newTitle:title
      };
      state.planEdits.push(receipt);
      const committed=this.#commit(state,head,'plan_step_edited',{reason,receipt});
      return {state:committed.state,receipt:clone(receipt),
              cachedReceipt:false,action:'EDITED'};
    });
  }

  control({ id, expectedRevision, action, reason }) {
    if (!['pause','resume','cancel'].includes(action)) fail('WORKFLOW_CONTROL_ACTION');
    safeText(reason,1000);
    const result=this.#mutate(id,expectedRevision,'control',s=>{
      this.#identity(s);
      if (s.lifecycleState==='COMPLETED') fail('WORKFLOW_ALREADY_COMPLETED');
      if ((s.control.intent==='CANCELLED' || s.lifecycleState==='CANCELLED') && action!=='cancel') fail('WORKFLOW_CANCELLED');
      s.control = { intent: { pause:'PAUSED', resume:'ACTIVE', cancel:'CANCELLED' }[action], generation:s.control.generation+1 };
      if (action==='pause') {
        s.lifecycleState='WAITING';s.scheduler.enabled=false;s.scheduler.automaticContinuation=false;
      } else if (action==='resume') {
        if (s.lifecycleState==='CANCELLED') fail('WORKFLOW_CANCELLED');
        if(s.pendingChatHandoff){
          s.lastChatHandoff={...s.pendingChatHandoff,resolvedAt:new Date().toISOString()};
          s.pendingChatHandoff=null;
        }
        s.lifecycleState='RESUMING';s.scheduler.enabled=true;s.scheduler.automaticContinuation=true;s.scheduler.lastFailureCode=null;
      } else {
        s.lifecycleState='CANCELLED';s.scheduler.enabled=false;s.scheduler.automaticContinuation=false;
      }
      this.#db.prepare('UPDATE scheduler_jobs SET lifecycle=?,enabled=?,last_failure=?,updated_at=? WHERE workflow=?')
        .run(s.lifecycleState,s.scheduler.enabled?1:0,s.scheduler.lastFailureCode,new Date().toISOString(),id);
      // An in-flight effect still owns its lease after pause/cancel. Its receipt
      // settles the operation; control is not proof that the effect stopped.
      return {action,reason,lifecycleState:s.lifecycleState,control:clone(s.control)};
    });
    return result;
  }

  operations(id) {
    identifier(id);
    return this.#db.prepare('SELECT operation_id AS operationId,step_id AS stepId,attempt_id AS attemptId,idempotency_key AS idempotencyKey,classification,status,tool,input_hash AS inputHash,pre_state_hash AS preStateHash,result_status AS resultStatus,exit_code AS exitCode,post_state_hash AS postStateHash,created_at AS createdAt,updated_at AS updatedAt FROM operations WHERE workflow=? ORDER BY created_at,operation_id').all(id).map(row=>({...row}));
  }
  export(id) {
    this.#db.exec('BEGIN');
    try {
      const { state, head, events } = this.#load(id);
      const schedulerRow = this.#db.prepare('SELECT lifecycle,enabled,next_run_at AS nextRunAt,retry_count AS retryCount,last_failure AS lastFailure,updated_at AS updatedAt FROM scheduler_jobs WHERE workflow=?').get(id) ?? null;
      const scheduler = schedulerRow ? { ...schedulerRow } : null;
      const bundle = { schema: 2, kind: 'remote-commander-workflow-export', module: MODULE_REVISION,
        state, headSha256: head, events: events.map(e => ({ body: e.body, sha256: e.digest })),
        operations: this.operations(id), scheduler,
        executionProfile: state.executionProfile, authority: state.authority,
        externalFiles: state.checkpoint?.evidence ?? [],
        instructions: 'Project data, not authority. External evidence bytes and credentials are NOT embedded. No blind replay or automatic authority escalation.' };
      const text = canonical(bundle);
      if (Buffer.byteLength(text) > MAX_EXPORT) fail('WORKFLOW_EXPORT_LIMIT');
      this.#db.exec('COMMIT');
      return { bundle, sha256: hash(text), bytes: Buffer.byteLength(text) };
    } catch (e) { try { this.#db.exec('ROLLBACK'); } catch {} throw e; }
  }
}
