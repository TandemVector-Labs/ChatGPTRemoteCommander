import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { watch as fsWatch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { expandPathValue } from './platform.mjs';

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'UNCERTAIN']);
const WORKER_FINALIZATION_GRACE_MS = 10000;
const WORKER_MISSING_RECEIPT_GRACE_MS = 2000;
const WORKER_SCHEDULING_HARD_GRACE_MS = 60000;
const REQUEST_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OP_RE = /^[a-f0-9-]{36}$/;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}
function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
async function atomicJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  let lastError;
  for (let attempt = 0; attempt <= 20; attempt += 1) {
    try {
      await rename(temp, target);
      return;
    } catch (error) {
      lastError = error;
      const transient = process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(error?.code);
      if (!transient || attempt === 20) break;
      await new Promise((resolve) => setTimeout(resolve, 25 + attempt * 10));
    }
  }
  throw lastError;
}
async function readJson(target) {
  return JSON.parse(await readFile(target, 'utf8'));
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function tailText(target, maxBytes) {
  if (!maxBytes) return '';
  try {
    const info = await stat(target);
    const start = Math.max(0, info.size - maxBytes);
    const handle = await open(target, 'r');
    try {
      const buffer = Buffer.alloc(info.size - start);
      await handle.read(buffer, 0, buffer.length, start);
      return buffer.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}
function boundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(Math.trunc(parsed), max)) : fallback;
}
function profileKey(config) {
  const raw = String(config.instance?.profile ?? 'default');
  return raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'default';
}

export const asyncOperationDefinitions = [
  {
    name: 'operation_start',
    description: 'Start a validated long-running command in a detached durable worker and return immediately. Reuse the same requestId on retry; identical retries return the same operationId and never start a duplicate effect.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' },
        correlationId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' },
        tool: { type: 'string', enum: ['run_project_command', 'run_shell', 'copy_path', 'move_path', 'delete_path'] },
        arguments: { type: 'object' },
        continuation: {
          type: 'object',
          properties: {
            projectId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' },
            eventKey: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' },
            root: { type: 'string', minLength: 1, maxLength: 4096 },
            phase: { type: 'string', maxLength: 256 },
            summary: { type: 'string', maxLength: 1200 },
            evidencePaths: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 512 } }
          },
          required: ['projectId', 'eventKey', 'root'],
          additionalProperties: false
        }
      },
      required: ['requestId', 'tool', 'arguments'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
  },
  {
    name: 'operation_status',
    description: 'Read compact durable status for a detached operation without returning command output. Optionally wait up to 5 seconds for a state change and return early on terminal state.',
    inputSchema: {
      type: 'object',
      properties: {
        operationId: { type: 'string', pattern: '^[a-f0-9-]{36}$' },
        waitMs: { type: 'integer', minimum: 0, maximum: 5000 }
      },
      required: ['operationId'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'operation_result',
    description: 'Read the compact result and bounded stdout/stderr tails for a detached operation. Captured output is file-backed, bounded by policy, and may be truncated; total byte counts and full-stream SHA-256 digests remain available.',
    inputSchema: {
      type: 'object',
      properties: {
        operationId: { type: 'string', pattern: '^[a-f0-9-]{36}$' },
        tailBytes: { type: 'integer', minimum: 0, maximum: 32768 }
      },
      required: ['operationId'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'operation_cancel',
    description: 'Request cancellation of a Commander-owned detached operation. Repeated cancellation is idempotent.',
    inputSchema: {
      type: 'object',
      properties: { operationId: { type: 'string', pattern: '^[a-f0-9-]{36}$' } },
      required: ['operationId'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }
];

export function createAsyncOperationTools({ config, prepare, workerPath, deliveryStore = null, onTerminal = null, validateContinuation = null, protectedDeliveryOrigin = null }) {
  // Only trusted Host bootstrap may supply these callbacks; operation_start
  // inputs are never allowed to select an owner/chat/grant or signed receipt.
  const declaredOriginRequirement=config.asyncOperations?.requireHostSignedOrigin;
  // A mistyped opt-in (e.g. the string 'true') must not silently enable legacy.
  if(declaredOriginRequirement!==undefined && typeof declaredOriginRequirement!=='boolean')
    throw new Error('ASYNC_DELIVERY_SIGNED_ORIGIN_POLICY_INVALID');
  const signedOriginRequired=declaredOriginRequirement===true;
  // Explicit protected-mode enrollment may never silently downgrade to the
  // legacy profile-scoped continuation path when no Host issuer is wired.
  if(signedOriginRequired && protectedDeliveryOrigin === null)
    throw new Error('ASYNC_DELIVERY_SIGNED_ORIGIN_HOST_REQUIRED');
  if(protectedDeliveryOrigin !== null &&
    (!deliveryStore || typeof protectedDeliveryOrigin?.admitOperation !== 'function'
      || typeof protectedDeliveryOrigin?.authorizeReplay !== 'function'
      || typeof protectedDeliveryOrigin?.authorizeAccess !== 'function'
      || typeof protectedDeliveryOrigin?.authorizeHandoff !== 'function'
      || typeof protectedDeliveryOrigin?.dispatchHandoff !== 'function'
      || typeof protectedDeliveryOrigin?.verifyHandoffReceipt !== 'function'
      || typeof protectedDeliveryOrigin?.receiptForTerminal !== 'function'
      || typeof protectedDeliveryOrigin?.publisher?.publish !== 'function'))
    throw new Error('ASYNC_DELIVERY_SIGNED_ORIGIN_HOST_REQUIRED');
  const policy = config.asyncOperations ?? {};
  const enabled = policy.enabled !== false;
  // Native protected dispatch is self-sufficient. Legacy onTerminal must
  // never be needed merely to activate protected continuation recovery.
  const continuationEnabled=Boolean(onTerminal || protectedDeliveryOrigin);
  const root = policy.stateDir
    ? path.resolve(expandPathValue(policy.stateDir))
    : path.join(os.homedir(), '.chatgpt-remote-commander', 'operations', profileKey(config));
  const maxOutputBytes = boundedInt(policy.maxOutputBytes, 16 * 1024 * 1024, 64 * 1024, 64 * 1024 * 1024);
  const resolvedWorker = workerPath ?? fileURLToPath(new URL('../tools/operation-worker.mjs', import.meta.url));
  const operationsDir = path.join(root, 'operations');
  const requestsDir = path.join(root, 'requests');
  const deliveryIntervalMs = boundedInt(policy.deliveryReconcileMs, 5000, 1000, 60000);
  const deliveryBatchSize = boundedInt(policy.deliveryReconcileBatch, 100, 1, 500);
  // A lost native enqueue receipt is retryable, but never forever. Limit
  // autonomous attempts per runtime; preserve pending state for reconciliation.
  const continuationRecoveryMaxAttempts=boundedInt(
    policy.continuationRecoveryMaxAttempts,8,1,32);
  const nativeHandoffHostTimeoutMs=boundedInt(
    policy.nativeHandoffHostTimeoutMs,10000,50,60000);
  const protectedOriginHostTimeoutMs=boundedInt(
    policy.protectedOriginHostTimeoutMs,10000,50,60000);
  const deliveryTracked = new Set();
  let deliveryDiscovered = false;
  let deliveryTimer = null;
  let deliveryClosed = false;
  let deliveryReconcilePromise = Promise.resolve({ checked: 0, pending: 0 });
  const reservationByOperation = new Map();
  let reservationsLoaded = false;
  const continuationRecovery = new Set();
  const continuationRecoveryTimers = new Map();
  const continuationRecoveryExhausted = new Set();
  const nativeHandoffsInFlight = new Map();
  const nonRetryableHandoffErrors = new Set([
    'ASYNC_CONTINUATION_OWNER_GRANT_DENIED',
    'ASYNC_CONTINUATION_ORIGIN_ADMISSION_MISMATCH',
    'ASYNC_CONTINUATION_ORIGINAL_PAYLOAD_MISMATCH',
    'ASYNC_CONTINUATION_NATIVE_RECEIPT_MISMATCH',
    'ASYNC_CONTINUATION_NATIVE_LEDGER_MISMATCH',
    'ASYNC_CONTINUATION_NATIVE_LEDGER_UNREADABLE',
    'ASYNC_CONTINUATION_NATIVE_RECEIPT_NOT_VERIFIED',
    'ASYNC_CONTINUATION_NATIVE_RETRY_EXHAUSTED'
  ]);
  let continuationClosed = false;

  function normalizeContinuation(value) {
    if (value === undefined) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid continuation');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.projectId ?? '') || !REQUEST_RE.test(value.eventKey ?? '')) throw new Error('invalid continuation');
    const boundedText = (item, max) => {
      if (item === undefined) return '';
      if (typeof item !== 'string' || item.includes('\0') || Buffer.byteLength(item, 'utf8') > max) throw new Error('invalid continuation');
      return item;
    };
    const evidencePaths = value.evidencePaths ?? [];
    if (!Array.isArray(evidencePaths) || evidencePaths.length > 10 ||
        evidencePaths.some(item => typeof item !== 'string' || !item || item.includes('\0') || Buffer.byteLength(item, 'utf8') > 512)) {
      throw new Error('invalid continuation');
    }
    return {
      projectId: value.projectId,
      eventKey: value.eventKey,
      root: boundedText(value.root, 4096),
      phase: boundedText(value.phase, 256),
      summary: boundedText(value.summary, 1200),
      evidencePaths: [...evidencePaths]
    };
  }

  function stopRecovery(operationId) {
    const timer=continuationRecoveryTimers.get(operationId);
    if(timer)clearTimeout(timer);
    continuationRecoveryTimers.delete(operationId);
    continuationRecovery.delete(operationId);
    continuationRecoveryExhausted.delete(operationId);
  }

  function observeWorkerExit(worker, operationId) {
    if (!continuationEnabled) return;
    worker.once('exit', () => {
      if (continuationClosed) return;
      queueMicrotask(() => {
        if (continuationClosed) return;
        status(operationId,true).then(state=>{
          if(!TERMINAL.has(state.status) ||
            (state.conversationHandoffPending && !state.conversationHandoffBlockedReason))
            scheduleRestartRecovery(operationId);
        }).catch(()=>scheduleRestartRecovery(operationId));
      });
    });
  }

  function scheduleRestartRecovery(operationId, attempt=0) {
    if(!continuationEnabled||continuationClosed
      ||continuationRecoveryTimers.has(operationId)
      ||continuationRecoveryExhausted.has(operationId))return;
    if(attempt>=continuationRecoveryMaxAttempts){
      continuationRecovery.delete(operationId);
      continuationRecoveryExhausted.add(operationId);
      return; // Do not convert unknown/lost ACK into proof of presentation.
    }
    continuationRecovery.add(operationId);
    const delay=Math.min(5000,250*(2**Math.min(attempt,5)));
    const timer=setTimeout(async()=>{
      continuationRecoveryTimers.delete(operationId);
      if(continuationClosed)return;
      let nextAttempt=attempt+1;
      try{
        const state=await status(operationId,true);
        if(TERMINAL.has(state.status)){
          if(!state.conversationHandoffPending || state.conversationHandoffBlockedReason){
            stopRecovery(operationId);return;
          }
        } else {
          // Monitoring a long-running worker must not consume its entire
          // retry budget before there is a terminal handoff to send.
          nextAttempt=0;
        }
      }catch{}
      scheduleRestartRecovery(operationId,nextAttempt);
    },delay);
    timer.unref?.();
    continuationRecoveryTimers.set(operationId,timer);
  }

  async function discoverContinuationOperations() {
    if (!continuationEnabled) return 0;
    let entries = [];
    try { entries = await readdir(operationsDir, { withFileTypes: true }); }
    catch (error) { if (error?.code === 'ENOENT') return 0; throw error; }
    let recovered = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !OP_RE.test(entry.name)) continue;
      try {
        const state = await readStateProjection(opPaths(entry.name));
        if (!state?.continuation) continue;
        if (TERMINAL.has(state.status)) {
          const delivered=await attachDelivery(state);
          if(delivered.conversationHandoffPending
            && !delivered.conversationHandoffBlockedReason)
            scheduleRestartRecovery(entry.name);
          recovered += 1;
        } else {
          scheduleRestartRecovery(entry.name);
        }
      } catch {}
    }
    return recovered;
  }

  function correlationOf(state) {
    const value = state?.correlationId ?? state?.requestId;
    return REQUEST_RE.test(value ?? '') ? value : null;
  }
  function compactReceipt(receipt) {
    if (!receipt) return null;
    const stream = value => value ? {
      capturedBytes: value.capturedBytes ?? null,
      totalBytes: value.totalBytes ?? null,
      sha256: value.sha256 ?? null,
      truncated: value.truncated === true
    } : null;
    return {
      operationId: receipt.operationId,
      tool: receipt.tool,
      inputHash: receipt.inputHash,
      status: receipt.status,
      exitCode: receipt.exitCode ?? null,
      signal: receipt.signal ?? null,
      timedOut: receipt.timedOut === true,
      cancelRequested: receipt.cancelRequested === true,
      outputComplete: receipt.outputComplete !== false,
      toolResult: receipt.toolResult ?? null,
      stdout: stream(receipt.stdout),
      stderr: stream(receipt.stderr),
      startedAt: receipt.startedAt ?? null,
      finishedAt: receipt.finishedAt ?? null
    };
  }

  function opPaths(operationId) {
    if (!OP_RE.test(operationId)) throw new Error('invalid operationId');
    const dir = path.join(operationsDir, operationId);
    return {
      dir,
      state: path.join(dir, 'state.json'),
      result: path.join(dir, 'result.json'),
      stdout: path.join(dir, 'stdout.log'),
      stderr: path.join(dir, 'stderr.log'),
      cancel: path.join(dir, 'cancel.request')
    };
  }
  function validReservation(value) {
    const correlationId = value?.correlationId ?? value?.requestId;
    return value
      && REQUEST_RE.test(value.requestId ?? '')
      && REQUEST_RE.test(correlationId ?? '')
      && OP_RE.test(value.operationId ?? '')
      && /^[a-f0-9]{64}$/.test(value.inputHash ?? '');
  }
  async function refreshReservationIndex() {
    let entries = [];
    try { entries = await readdir(requestsDir, { withFileTypes: true }); }
    catch (error) { if (error?.code === 'ENOENT') { reservationsLoaded = true; return; } throw error; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      let reservation = null;
      try { reservation = await readJson(path.join(requestsDir, entry.name)); } catch { continue; }
      if (!validReservation(reservation)) continue;
      const prior = reservationByOperation.get(reservation.operationId);
      if (prior === false) continue;
      if (prior && (prior.requestId !== reservation.requestId
        || (prior.correlationId ?? prior.requestId) !== (reservation.correlationId ?? reservation.requestId)
        || prior.inputHash !== reservation.inputHash)) {
        reservationByOperation.set(reservation.operationId, false);
        continue;
      }
      reservationByOperation.set(reservation.operationId, reservation);
    }
    reservationsLoaded = true;
  }
  async function reservationForOperation(operationId) {
    if (!reservationsLoaded) await refreshReservationIndex();
    let reservation = reservationByOperation.get(operationId);
    if (reservation === undefined) {
      await refreshReservationIndex();
      reservation = reservationByOperation.get(operationId);
    }
    return reservation && reservation !== false ? reservation : null;
  }
  async function preserveCorruptProjection(p) {
    let bytes;
    try { bytes = await readFile(p.state); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const backup = path.join(p.dir, `state.corrupt-${sha256}.bin`);
    try {
      await writeFile(backup, bytes, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await readFile(backup);
      if (createHash('sha256').update(existing).digest('hex') !== sha256) throw new Error('CORRUPT_STATE_BACKUP_CONFLICT');
    }
    return path.basename(backup);
  }
  async function recoverTerminalProjection(operationId) {
    const reservation = await reservationForOperation(operationId);
    if (!reservation) return null;
    const p = opPaths(operationId);
    let receipt = null;
    try { receipt = await readJson(p.result); } catch { return null; }
    const correlationId = reservation.correlationId ?? reservation.requestId;
    if (!receipt
      || receipt.operationId !== operationId
      || receipt.inputHash !== reservation.inputHash
      || !TERMINAL.has(receipt.status)
      || typeof receipt.tool !== 'string'
      || !REQUEST_RE.test(correlationId)) return null;
    const corruptProjectionBackup = await preserveCorruptProjection(p);
    const finishedAt = receipt.finishedAt ?? new Date().toISOString();
    const recovered = {
      schema: 1,
      operationId,
      requestId: reservation.requestId,
      correlationId,
      deliveryMode: reservation.deliveryMode ?? 'durable',
      inputHash: receipt.inputHash,
      tool: receipt.tool,
      continuation: reservation.continuation ?? null,
      ...(reservation.originAdmissionId ? {originAdmissionId:reservation.originAdmissionId} : {}),
      status: receipt.status,
      createdAt: reservation.createdAt ?? receipt.startedAt ?? finishedAt,
      updatedAt: finishedAt,
      finishedAt: receipt.finishedAt ?? null,
      workerPid: null,
      childPid: null,
      exitCode: receipt.exitCode ?? null,
      signal: receipt.signal ?? null,
      timedOut: receipt.timedOut === true,
      cancelRequested: receipt.cancelRequested === true,
      recoveredFromReceipt: true,
      recoveredFromCorruptProjection: true,
      corruptProjectionBackup
    };
    await atomicJson(p.state, recovered);
    return recovered;
  }
  async function publishTerminal(state) {
    if (!deliveryStore || !state || !TERMINAL.has(state.status)) return null;
    if (state.deliveryMode === 'transport-retry-only') {
      deliveryTracked.delete(state.operationId);
      return null;
    }
    const correlationId = correlationOf(state);
    if (!correlationId) return null;
    const p = opPaths(state.operationId);
    let receipt = null;
    try { receipt = await readJson(p.result); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const payload = compactReceipt(receipt) ?? {
      operationId: state.operationId,
      tool: state.tool,
      inputHash: state.inputHash,
      status: state.status,
      failureCode: state.failureCode ?? null,
      finishedAt: state.finishedAt ?? null
    };
    const artifact = deliveryStore.writeArtifact(payload);
    const kind = state.status === 'SUCCEEDED' ? 'COMPLETED'
      : state.status === 'CANCELLED' ? 'CANCELLED'
        : state.status === 'UNCERTAIN' ? 'UNCERTAIN' : 'FAILED';
    const eventInput = Object.freeze({
      eventKey: 'operation:' + state.operationId + ':' + state.status,
      source: 'operation',
      sourceId: state.operationId,
      kind,
      code: state.failureCode ?? state.status,
      artifact: Object.freeze({...artifact})
    });
    let event;
    if(protectedDeliveryOrigin){
      // Validate admission against the original durable request reservation;
      // a late/current-chat receipt may never substitute for missing admission.
      const reservation=await reservationForOperation(state.operationId);
      if(!reservation||!REQUEST_RE.test(state.originAdmissionId??'')
        ||reservation.originAdmissionId!==state.originAdmissionId
        ||reservation.requestId!==state.requestId
        ||reservation.inputHash!==state.inputHash
        ||(reservation.correlationId??reservation.requestId)!==correlationId)
        throw new Error('ASYNC_DELIVERY_SIGNED_ORIGIN_ADMISSION_MISMATCH');
      // The internal host issuer must independently establish the ORIGINAL
      // inputHash/principal/chat/consent epoch. A failed issuer/verifier cannot
      // fall back to legacy profile-scoped publication or synthesize an ACK.
      const request=Object.freeze({
        operationId:state.operationId,requestId:state.requestId,
        correlationId,inputHash:state.inputHash,tool:state.tool,
        originAdmissionId:reservation.originAdmissionId,
        status:state.status,event:eventInput
      });
      const receiptId=await boundedTrustedHostCall(
        'ASYNC_DELIVERY_SIGNED_ORIGIN_ISSUER_TIMEOUT',
        ()=>protectedDeliveryOrigin.receiptForTerminal(request),
        protectedOriginHostTimeoutMs);
      if(typeof receiptId!=='string'||!REQUEST_RE.test(receiptId))
        throw new Error('ASYNC_DELIVERY_SIGNED_ORIGIN_RECEIPT_REQUIRED');
      event=await boundedTrustedHostCall(
        'ASYNC_DELIVERY_SIGNED_ORIGIN_PUBLICATION_TIMEOUT',
        ()=>protectedDeliveryOrigin.publisher.publish(
          Object.freeze({...eventInput,receiptId}),
          Object.freeze({inputHash:state.inputHash,correlationId,
            originAdmissionId:reservation.originAdmissionId})),
        protectedOriginHostTimeoutMs);
    } else {
      event=deliveryStore.publish({...eventInput,correlationId});
    }
    deliveryTracked.delete(state.operationId);
    return event;
  }
  async function boundedTrustedHostCall(code,callback,deadlineMs=nativeHandoffHostTimeoutMs){
    // Do not leave a public status request waiting indefinitely on a native
    // Host/issuer callback. A timed-out dispatch may still complete remotely;
    // preserve its charged durable handoffKey and never fabricate an ACK.
    let timer=null;
    try{
      return await Promise.race([
        Promise.resolve().then(callback),
        new Promise((_,reject)=>{
          timer=setTimeout(()=>reject(new Error(code)),deadlineMs);
        })
      ]);
    }finally{if(timer!==null)clearTimeout(timer);}
  }

  function validNativeHandoffReceipt(receipt,request){
    return receipt && typeof receipt==='object' && !Array.isArray(receipt)
      && typeof receipt.handoffId==='string'
      && REQUEST_RE.test(receipt.handoffId)
      && ['QUEUED','CLAIMED','DEFERRED','UNCERTAIN','SENT'].includes(receipt.state)
      && receipt.handoffKey===request.handoffKey
      && receipt.deliveryId===request.deliveryId
      && receipt.originAdmissionId===request.originAdmissionId;
  }

  async function readNativeHandoffLedger(target,request){
    let ledger;
    try { ledger=await readJson(target); }
    catch(error) {
      if(error?.code==='ENOENT')return null;
      throw new Error('ASYNC_CONTINUATION_NATIVE_LEDGER_UNREADABLE');
    }
    if(!ledger || typeof ledger!=='object' || Array.isArray(ledger)
      || ledger.version!==1
      || ledger.operationId!==request.operationId
      || ledger.handoffKey!==request.handoffKey
      || ledger.deliveryId!==request.deliveryId
      || ledger.originAdmissionId!==request.originAdmissionId
      || !Number.isSafeInteger(ledger.attempts) || ledger.attempts<0
      || ledger.attempts>100000
      || (ledger.receipt!==null && !validNativeHandoffReceipt(ledger.receipt,request))
      || (ledger.blockedReason!==null
        && ledger.blockedReason!=='ASYNC_CONTINUATION_NATIVE_RECEIPT_MISMATCH'))
      throw new Error('ASYNC_CONTINUATION_NATIVE_LEDGER_MISMATCH');
    return ledger;
  }

  function dispatchNativeHandoffSingleflight(request,payload){
    // In-process single flight is NOT cross-process delivery permission or
    // durable Host idempotency. The native receiver remains authoritative.
    const key=request.handoffKey;
    let task=nativeHandoffsInFlight.get(key);
    if(!task){
      task=(async()=>{
        const target=path.join(opPaths(request.operationId).dir,'native-handoff.json');
        const claimPath=path.join(opPaths(request.operationId).dir,'native-handoff.claim');
        // Exclusive creation arbitrates TWO manager processes that share the
        // same operation directory. Per-manager Promise singleflight alone
        // cannot prevent concurrent ledger overwrites/duplicate Host calls.
        // A claim surviving a crash is intentionally never auto-stolen.
        let claim=null,claimOwned=false,retainUncertainClaim=false;
        try{
          try { claim=await open(claimPath,'wx',0o600);claimOwned=true; }
          catch(error){
            if(error?.code==='EEXIST')
              throw new Error('ASYNC_CONTINUATION_NATIVE_IN_FLIGHT');
            throw error;
          }
          await claim.writeFile(JSON.stringify({
            schema:1,handoffKey:key,pid:process.pid,
            claimedAt:new Date().toISOString()
          })+'\n');
          await claim.close();
          claim=null;
          const prior=await readNativeHandoffLedger(target,request);
          if(prior?.receipt){
            // The local JSON file is NOT evidence of issuer authenticity.
            // Independently verify it against a Host-owned, authenticated
            // durable enqueue record before accepting a cached receipt.
            const verified=await boundedTrustedHostCall(
              'ASYNC_CONTINUATION_NATIVE_VERIFY_TIMEOUT',
              ()=>protectedDeliveryOrigin.verifyHandoffReceipt(
                request,Object.freeze({...prior.receipt})));
            if(verified!==true)
              throw new Error('ASYNC_CONTINUATION_NATIVE_RECEIPT_NOT_VERIFIED');
            return prior.receipt; // Verified queue receipt, not ChatGPT ACK.
          }
          if(prior?.blockedReason)
            throw new Error(prior.blockedReason);
          if((prior?.attempts??0)>=continuationRecoveryMaxAttempts)
            throw new Error('ASYNC_CONTINUATION_NATIVE_RETRY_EXHAUSTED');
          // Conservatively charge the attempt BEFORE the external Host effect.
          // A crash between dispatch and response cannot restart the budget.
          const record={
            version:1,operationId:request.operationId,
            originAdmissionId:request.originAdmissionId,
            deliveryId:request.deliveryId,handoffKey:key,
            attempts:(prior?.attempts??0)+1,
            receipt:null,blockedReason:null
          };
          await atomicJson(target,record);
          const raw=await boundedTrustedHostCall(
            'ASYNC_CONTINUATION_NATIVE_DISPATCH_TIMEOUT',
            ()=>protectedDeliveryOrigin.dispatchHandoff(request,payload));
          if(raw===null || raw===undefined)
            throw new Error('ASYNC_CONTINUATION_NATIVE_RECEIPT_UNAVAILABLE');
          if(!validNativeHandoffReceipt(raw,request)){
            await atomicJson(target,{
              ...record,blockedReason:'ASYNC_CONTINUATION_NATIVE_RECEIPT_MISMATCH'
            });
            throw new Error('ASYNC_CONTINUATION_NATIVE_RECEIPT_MISMATCH');
          }
          // Persist only validated receipt fields, never caller-provided extras.
          const receipt={
            handoffId:raw.handoffId,state:raw.state,
            handoffKey:key,deliveryId:request.deliveryId,
            originAdmissionId:request.originAdmissionId
          };
          const verified=await boundedTrustedHostCall(
            'ASYNC_CONTINUATION_NATIVE_VERIFY_TIMEOUT',
            ()=>protectedDeliveryOrigin.verifyHandoffReceipt(
              request,Object.freeze({...receipt})));
          if(verified!==true){
            // Host authenticity failure is not a transient lost transport ACK.
            await atomicJson(target,{
              ...record,blockedReason:'ASYNC_CONTINUATION_NATIVE_RECEIPT_MISMATCH'
            });
            throw new Error('ASYNC_CONTINUATION_NATIVE_RECEIPT_NOT_VERIFIED');
          }
          await atomicJson(target,{...record,receipt});
          return receipt;
        }catch(error){
          // The callback may have committed remotely after our deadline.
          // Retain a claim rather than start a second unverified send.
          if(error?.message==='ASYNC_CONTINUATION_NATIVE_DISPATCH_TIMEOUT')
            retainUncertainClaim=true;
          throw error;
        }finally{
          if(claim)await claim.close();
          if(claimOwned && !retainUncertainClaim){
            try{await unlink(claimPath);}
            catch(error){if(error?.code!=='ENOENT')throw error;}
          }
        }
      })();
      nativeHandoffsInFlight.set(key,task);
      const clear=()=>{
        if(nativeHandoffsInFlight.get(key)===task)nativeHandoffsInFlight.delete(key);
      };
      void task.then(clear,clear);
    }
    return task;
  }

  async function attachDelivery(state) {
    if (!TERMINAL.has(state?.status)) return state;
    let result = state;
    if (deliveryStore) {
      try {
        const event = await publishTerminal(state);
        if (event) result = { ...result, deliveryId: event.deliveryId };
      } catch {
        deliveryTracked.add(state.operationId);
        result = { ...result, deliveryPending: true };
      }
    }
    let continuationDelivered = true;
    if (continuationEnabled && state.continuation) {
      try {
        let authorizedHandoff=null;
        if(protectedDeliveryOrigin){
          // Native chat signaling is another delivery channel: never bypass
          // a failed or unsigned durable original result by using onTerminal.
          if(!result.deliveryId || result.deliveryPending)
            throw new Error('ASYNC_CONTINUATION_SIGNED_DELIVERY_REQUIRED');
          const original=await reservationForOperation(state.operationId);
          const correlationId=correlationOf(state);
          if(!original || !REQUEST_RE.test(original.originAdmissionId??'')
            || !correlationId || original.operationId!==state.operationId
            || original.requestId!==state.requestId
            || original.inputHash!==state.inputHash
            || (original.correlationId??original.requestId)!==correlationId
            || original.originAdmissionId!==state.originAdmissionId)
            throw new Error('ASYNC_CONTINUATION_ORIGIN_ADMISSION_MISMATCH');
          const continuationHash=hashJson(state.continuation);
          // A state projection can be replaced independently of the original
          // request reservation. Never signal a different event, project, root
          // or message after execution or during restart recovery.
          if(!original.continuation
            || !/^[a-f0-9]{64}$/.test(original.continuationHash??'')
            || original.continuationHash!==continuationHash
            || hashJson(original.continuation)!==continuationHash)
            throw new Error('ASYNC_CONTINUATION_ORIGINAL_PAYLOAD_MISMATCH');
          // A deterministic key survives status polling, lost callback ACK,
          // crash recovery and reopening the same signed original result.
          const handoffKey=hashJson({
            operationId:state.operationId,
            originAdmissionId:original.originAdmissionId,
            deliveryId:result.deliveryId,continuationHash
          });
          authorizedHandoff=Object.freeze({
            operationId:state.operationId,
            requestId:state.requestId,
            correlationId,inputHash:state.inputHash,
            originAdmissionId:original.originAdmissionId,
            deliveryId:result.deliveryId,continuationHash,handoffKey
          });
          if(await boundedTrustedHostCall(
            'ASYNC_CONTINUATION_NATIVE_AUTH_TIMEOUT',
            ()=>protectedDeliveryOrigin.authorizeHandoff(authorizedHandoff))!==true)
            throw new Error('ASYNC_CONTINUATION_OWNER_GRANT_DENIED');
          // The native callback itself may revoke/regrant while awaited.
          if(await boundedTrustedHostCall(
            'ASYNC_CONTINUATION_NATIVE_AUTH_TIMEOUT',
            ()=>protectedDeliveryOrigin.authorizeHandoff(authorizedHandoff))!==true)
            throw new Error('ASYNC_CONTINUATION_OWNER_GRANT_DENIED');
        }
        // The native Host owns the final grant check AND actual chat delivery
        // in one trusted operation. Do not call the legacy onTerminal handler
        // after a separate permission check (time-of-check/time-of-use race).
        const handoff=protectedDeliveryOrigin
          ? await dispatchNativeHandoffSingleflight(
            authorizedHandoff,Object.freeze({
              status:state.status,
              continuation:Object.freeze({
                ...state.continuation,
                evidencePaths:Object.freeze([...(state.continuation.evidencePaths??[])])
              })
            }))
          : await onTerminal(state);
        if(protectedDeliveryOrigin){
          // A native invocation without an exact, durable enqueue receipt is
          // indeterminate; keep recovery pending. Never treat HTTP 2xx or
          // null as proof of originating-chat presentation.
          if(handoff===null || handoff===undefined)
            throw new Error('ASYNC_CONTINUATION_NATIVE_RECEIPT_UNAVAILABLE');
          if(typeof handoff!=='object'
            || typeof handoff.handoffId!=='string'
            || !REQUEST_RE.test(handoff.handoffId)
            || !['QUEUED','CLAIMED','DEFERRED','UNCERTAIN','SENT'].includes(handoff.state)
            || handoff.handoffKey!==authorizedHandoff.handoffKey
            || handoff.deliveryId!==authorizedHandoff.deliveryId
            || handoff.originAdmissionId!==authorizedHandoff.originAdmissionId)
            throw new Error('ASYNC_CONTINUATION_NATIVE_RECEIPT_MISMATCH');
        }
        if (handoff?.handoffId) result = {
          ...result,
          conversationHandoffId: handoff.handoffId,
          conversationHandoffState: handoff.state
        };
      } catch(error) {
        continuationDelivered = false;
        const reason=error?.message;
        const blocked=Boolean(protectedDeliveryOrigin
          && nonRetryableHandoffErrors.has(reason));
        if(blocked)stopRecovery(state.operationId);
        else continuationRecovery.add(state.operationId);
        result = { ...result, conversationHandoffPending: true,
          ...(blocked ? {conversationHandoffBlockedReason:reason} : {})
        };
      }
    }
    if (continuationDelivered) {
      stopRecovery(state.operationId);
    }
    return result;
  }
  async function readStateProjection(p) {
    for (let attempt = 0; attempt <= 20; attempt += 1) {
      try { return await readJson(p.state); }
      catch (error) {
        const transientAccess = process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(error?.code);
        if (error?.code !== 'ENOENT' && !transientAccess) throw error;
        try { await stat(p.dir); }
        catch (dirError) {
          if (dirError?.code === 'ENOENT') throw new Error('operation not found');
          throw dirError;
        }
        if (attempt === 20) {
          if (error?.code === 'ENOENT') throw new Error('operation not found');
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 10 + attempt * 2));
      }
    }
    throw new Error('operation not found');
  }
  async function status(operationId, reconcile = true) {
    const p = opPaths(operationId);
    let state;
    try { state = await readStateProjection(p); }
    catch (error) {
      if (reconcile) {
        const recovered = await recoverTerminalProjection(operationId);
        if (recovered) return attachDelivery(recovered);
      }
      throw error;
    }

    const exactReceipt = async (candidate) => {
      let receipt = null;
      try { receipt = await readJson(p.result); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      return receipt
        && receipt.operationId === candidate.operationId
        && receipt.inputHash === candidate.inputHash
        && TERMINAL.has(receipt.status)
        && receipt.status !== 'UNCERTAIN'
        ? receipt : null;
    };
    const adoptReceipt = async (candidate, receipt) => {
      const recovered = {
        ...candidate,
        status: receipt.status,
        updatedAt: receipt.finishedAt ?? new Date().toISOString(),
        finishedAt: receipt.finishedAt ?? null,
        exitCode: receipt.exitCode ?? null,
        signal: receipt.signal ?? null,
        timedOut: receipt.timedOut === true,
        cancelRequested: receipt.cancelRequested === true,
        recoveredFromReceipt: true
      };
      try { await atomicJson(p.state, recovered); } catch { recovered.stateRepairPending = true; }
      return recovered;
    };

    if (reconcile) {
      const receipt = await exactReceipt(state);
      if (receipt) return attachDelivery(await adoptReceipt(state, receipt));
    }
    if (TERMINAL.has(state.status)) return attachDelivery(state);

    if (reconcile) {
      const now = Date.now();
      const deadlineAtMs = typeof state.deadlineAt === 'string' ? Date.parse(state.deadlineAt) : NaN;
      const deadlineExpired = Number.isFinite(deadlineAtMs) && now > deadlineAtMs + 5000;
      const workerPid = Number(state.workerPid);
      const workerPidValid = Number.isSafeInteger(workerPid) && workerPid > 0;
      const workerAlive = workerPidValid && alive(workerPid);
      const workerMissing = workerPidValid && !workerAlive;
      const updatedAtMs = typeof state.updatedAt === 'string' ? Date.parse(state.updatedAt) : NaN;
      const staleQueued = state.status === 'QUEUED'
        && Number.isFinite(updatedAtMs)
        && now > updatedAtMs + WORKER_SCHEDULING_HARD_GRACE_MS;
      if (deadlineExpired || workerMissing || staleQueued) {
        const latest = await readJson(p.state);
        const receipt = await exactReceipt(latest);
        if (receipt) return attachDelivery(await adoptReceipt(latest, receipt));
        if (TERMINAL.has(latest.status)) return attachDelivery(latest);

        const latestNow = Date.now();
        const latestDeadlineAtMs = typeof latest.deadlineAt === 'string' ? Date.parse(latest.deadlineAt) : NaN;
        const latestDeadlineExpired = Number.isFinite(latestDeadlineAtMs)
          && latestNow > latestDeadlineAtMs + 5000;
        const latestWorkerPid = Number(latest.workerPid);
        const latestWorkerPidValid = Number.isSafeInteger(latestWorkerPid) && latestWorkerPid > 0;
        const latestWorkerAlive = latestWorkerPidValid && alive(latestWorkerPid);
        const latestUpdatedAtMs = typeof latest.updatedAt === 'string' ? Date.parse(latest.updatedAt) : NaN;
        const staleQueued = latest.status === 'QUEUED'
          && Number.isFinite(latestUpdatedAtMs)
          && latestNow > latestUpdatedAtMs + WORKER_SCHEDULING_HARD_GRACE_MS;
        const missingWorker = latestWorkerPidValid && !latestWorkerAlive;
        const missingWorkerExpired = missingWorker
          && (!Number.isFinite(latestUpdatedAtMs)
            || latestNow > latestUpdatedAtMs + WORKER_MISSING_RECEIPT_GRACE_MS);
        if (!latestDeadlineExpired && !staleQueued && !missingWorkerExpired) return latest;

        if (latestWorkerAlive && !staleQueued) {
          const startedAtMs = typeof latest.startedAt === 'string' ? Date.parse(latest.startedAt) : NaN;
          const timeoutMs = Number(latest.timeoutMs);
          const timeoutValid = Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000;
          const createdAtMs = typeof latest.createdAt === 'string' ? Date.parse(latest.createdAt) : NaN;
          const liveWorkerHardDeadline = Number.isFinite(startedAtMs) && timeoutValid
            ? startedAtMs + timeoutMs + WORKER_FINALIZATION_GRACE_MS
            : Number.isFinite(createdAtMs) && timeoutValid
              ? createdAtMs + timeoutMs + WORKER_SCHEDULING_HARD_GRACE_MS
              : NaN;
          if (!Number.isFinite(liveWorkerHardDeadline) || latestNow <= liveWorkerHardDeadline) {
            return latest;
          }
        }

        state = {
          ...latest,
          status: 'UNCERTAIN',
          updatedAt: new Date().toISOString(),
          failureCode: staleQueued ? 'QUEUED_WORKER_STALLED_WITHOUT_FINAL_RECEIPT'
            : missingWorkerExpired ? 'WORKER_MISSING_WITHOUT_FINAL_RECEIPT'
            : 'DEADLINE_EXCEEDED_WITHOUT_FINAL_RECEIPT'
        };
        await atomicJson(p.state, state);
        return attachDelivery(state);
      }
    }

    return state;
  }

  async function statusWithWait(operationId, waitMs = 0) {
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 5000) throw new Error('invalid waitMs');
    let current = await status(operationId);
    if (waitMs === 0 || TERMINAL.has(current.status)) return current;
    const p = opPaths(operationId);
    const watchDir = await realpath(p.dir);
    return new Promise((resolve, reject) => {
      let done = false;
      let watcher = null;
      let timer = null;
      let reading = false;
      const finish = (value, error = null) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        try { watcher?.close(); } catch {}
        if (error) reject(error); else resolve(value);
      };
      const refresh = async () => {
        if (done || reading) return;
        reading = true;
        try {
          current = await status(operationId);
          if (TERMINAL.has(current.status)) finish(current);
        } catch (error) {
          finish(null, error);
        } finally {
          reading = false;
        }
      };
      try {
        watcher = fsWatch(watchDir, { persistent: false }, () => { refresh(); });
        watcher.on('error', () => {});
      } catch {}
      timer = setTimeout(async () => {
        try { finish(await status(operationId)); }
        catch (error) { finish(null, error); }
      }, waitMs);
      // The caller awaits this timeout. Unlike autonomous background timers,
      // it must keep Node alive when the worker and fs watcher are unref'ed.
    });
  }

  async function start(input) {
    if (!enabled) throw new Error('async operations are disabled');
    if (!REQUEST_RE.test(input.requestId)) throw new Error('invalid requestId');
    const correlationId = input.correlationId ?? input.requestId;
    if (!REQUEST_RE.test(correlationId)) throw new Error('invalid correlationId');
    const deliveryMode = input.__deliveryMode === 'transport-retry-only' ? 'transport-retry-only' : 'durable';
    const inputHash = hashJson({ tool: input.tool, arguments: input.arguments });
    const continuation = normalizeContinuation(input.continuation);
    if (continuation && validateContinuation && !protectedDeliveryOrigin)
      await validateContinuation(continuation);
    const continuationHash = continuation ? hashJson(continuation) : null;
    await mkdir(requestsDir, { recursive: true, mode: 0o700 });
    await mkdir(operationsDir, { recursive: true, mode: 0o700 });
    const requestPath = path.join(requestsDir, `${hashJson(input.requestId)}.json`);
    const authorizeProtectedReplay = async (prior, validate = true) => {
      if (!protectedDeliveryOrigin) return;
      if (!REQUEST_RE.test(prior.originAdmissionId ?? '')
        || !OP_RE.test(prior.operationId ?? ''))
        throw new Error('ASYNC_DELIVERY_SIGNED_ORIGIN_REPLAY_DENIED');
      const original=Object.freeze({
        operationId:prior.operationId,requestId:prior.requestId,
        correlationId:prior.correlationId??prior.requestId,
        inputHash:prior.inputHash,originAdmissionId:prior.originAdmissionId
      });
      if(await boundedTrustedHostCall('ASYNC_DELIVERY_SIGNED_ORIGIN_REPLAY_TIMEOUT',
          ()=>protectedDeliveryOrigin.authorizeReplay(original),
          protectedOriginHostTimeoutMs)!==true)
        throw new Error('ASYNC_DELIVERY_SIGNED_ORIGIN_REPLAY_DENIED');
      if (validate && continuation && validateContinuation) {
        await validateContinuation(continuation);
        // The callback may revoke the consent that was valid on entry.
        if(await boundedTrustedHostCall('ASYNC_DELIVERY_SIGNED_ORIGIN_REPLAY_TIMEOUT',
          ()=>protectedDeliveryOrigin.authorizeReplay(original),
          protectedOriginHostTimeoutMs)!==true)
          throw new Error('ASYNC_DELIVERY_SIGNED_ORIGIN_REPLAY_DENIED');
      }
    };
    try {
      const prior = await readJson(requestPath);
      if (prior.requestId !== input.requestId || prior.inputHash !== inputHash ||
          (prior.correlationId ?? prior.requestId) !== correlationId ||
          (prior.continuationHash ?? null) !== continuationHash ||
          (prior.deliveryMode !== undefined && prior.deliveryMode !== deliveryMode)) {
        throw new Error('REQUEST_ID_CONFLICT');
      }
      await authorizeProtectedReplay(prior);
      let priorState;
      try { priorState = await status(prior.operationId); }
      catch (error) {
        if (error.message !== 'operation not found') throw error;
        priorState = { operationId: prior.operationId, status: 'UNCERTAIN', failureCode: 'RESERVED_WITHOUT_STATE' };
      }
      // Status reconciliation may await receipt I/O and outlive the old grant.
      await authorizeProtectedReplay(prior,false);
      return { operationId: prior.operationId, requestId: input.requestId, correlationId, duplicate: true, status: priorState.status, deliveryId: priorState.deliveryId ?? null };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const operationId = randomUUID();
    let originAdmissionId = null;
    if(protectedDeliveryOrigin){
      // Called before reserving or spawning any effect. It must independently
      // verify the current authenticated issuer, chat and owner consent.
      // Never derive the grant from MCP input fields or current chat at finish.
      originAdmissionId=await boundedTrustedHostCall(
        'ASYNC_DELIVERY_SIGNED_ORIGIN_ADMISSION_TIMEOUT',
        ()=>protectedDeliveryOrigin.admitOperation(
          Object.freeze({operationId,requestId:input.requestId,
            correlationId,inputHash,tool:input.tool,continuationHash})),
        protectedOriginHostTimeoutMs);
      if(typeof originAdmissionId!=='string'||!REQUEST_RE.test(originAdmissionId))
        throw new Error('ASYNC_DELIVERY_SIGNED_ORIGIN_ADMISSION_REQUIRED');
      // Admission can itself await network/native consent. Require the same
      // live grant before any preparatory Host callback can run.
      const live=await boundedTrustedHostCall(
        'ASYNC_DELIVERY_SIGNED_ORIGIN_REPLAY_TIMEOUT',
        ()=>protectedDeliveryOrigin.authorizeReplay(Object.freeze({
          operationId,requestId:input.requestId,correlationId,inputHash,
          originAdmissionId
        })),
        protectedOriginHostTimeoutMs);
      if(live!==true)
        throw new Error('ASYNC_DELIVERY_SIGNED_ORIGIN_ADMISSION_REVOKED');
    }
    if(protectedDeliveryOrigin && continuation && validateContinuation) {
      await validateContinuation(continuation);
      const stillGranted=await boundedTrustedHostCall(
        'ASYNC_DELIVERY_SIGNED_ORIGIN_REPLAY_TIMEOUT',
        ()=>protectedDeliveryOrigin.authorizeReplay(Object.freeze({
          operationId,requestId:input.requestId,correlationId,inputHash,
          originAdmissionId
        })),
        protectedOriginHostTimeoutMs);
      if(stillGranted!==true)
        throw new Error('ASYNC_DELIVERY_SIGNED_ORIGIN_ADMISSION_REVOKED');
    }
    // The preparer is Host code and may do I/O; it must never run before
    // independent owner/chat admission in the protected path.
    const prepared = await prepare(input.tool, input.arguments);
    const processPlan = prepared && (prepared.kind === undefined || prepared.kind === 'process')
      && typeof prepared.file === 'string' && Array.isArray(prepared.args) && typeof prepared.cwd === 'string';
    const powerToolPlan = prepared?.kind === 'power-tool'
      && typeof prepared.configPath === 'string'
      && /^[a-f0-9]{64}$/.test(prepared.configSha256 ?? '');
    if (!processPlan && !powerToolPlan) throw new Error('invalid async execution plan');
    let claimed = false;
    try {
      const handle = await open(requestPath, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ requestId: input.requestId, correlationId, operationId, inputHash, continuationHash, continuation, deliveryMode, ...(originAdmissionId ? {originAdmissionId} : {}), createdAt: new Date().toISOString() }) + '\n');
      } finally {
        await handle.close();
      }
      claimed = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    if (!claimed) {
      const prior = await readJson(requestPath);
      if (prior.requestId !== input.requestId || prior.inputHash !== inputHash ||
          (prior.correlationId ?? prior.requestId) !== correlationId ||
          (prior.continuationHash ?? null) !== continuationHash ||
          (prior.deliveryMode !== undefined && prior.deliveryMode !== deliveryMode)) {
        throw new Error('REQUEST_ID_CONFLICT');
      }
      await authorizeProtectedReplay(prior);
      let priorState;
      try { priorState = await status(prior.operationId); }
      catch (error) {
        if (error.message !== 'operation not found') throw error;
        priorState = { operationId: prior.operationId, status: 'UNCERTAIN', failureCode: 'RESERVED_WITHOUT_STATE' };
      }
      // Status reconciliation may await receipt I/O and outlive the old grant.
      await authorizeProtectedReplay(prior,false);
      return { operationId: prior.operationId, requestId: input.requestId, correlationId, duplicate: true, status: priorState.status, deliveryId: priorState.deliveryId ?? null };
    }

    const p = opPaths(operationId);
    await mkdir(p.dir, { recursive: true, mode: 0o700 });
    const operationTimeoutMs = boundedInt(prepared.timeoutMs, 300000, 1000, 24 * 60 * 60 * 1000);
    const outputLimit = Math.min(boundedInt(prepared.outputLimit, maxOutputBytes, 4096, maxOutputBytes), maxOutputBytes);
    const now = new Date().toISOString();
    const baseState = {
      schema: 1,
      operationId,
      requestId: input.requestId,
      correlationId,
      deliveryMode,
      inputHash,
      tool: input.tool,
      status: 'QUEUED',
      createdAt: now,
      updatedAt: now,
      timeoutMs: operationTimeoutMs,
      deadlineAt: new Date(Date.now() + operationTimeoutMs).toISOString(),
      workerPid: null,
      childPid: null,
      continuation,
      ...(originAdmissionId ? {originAdmissionId} : {})
    };
    await atomicJson(p.state, baseState);
    if (deliveryStore && deliveryMode === 'durable') deliveryTracked.add(operationId);
    const execution = {
      kind: powerToolPlan ? 'power-tool' : 'process',
      operationId,
      requestId: input.requestId,
      correlationId,
      inputHash,
      tool: input.tool,
      ...(powerToolPlan ? {
        configPath: prepared.configPath,
        configSha256: prepared.configSha256,
        toolArguments: input.arguments
      } : {
        file: prepared.file,
        args: prepared.args,
        cwd: prepared.cwd
      }),
      timeoutMs: operationTimeoutMs,
      outputLimit,
      statePath: p.state,
      resultPath: p.result,
      stdoutPath: p.stdout,
      stderrPath: p.stderr,
      cancelPath: p.cancel
    };
    if(protectedDeliveryOrigin){
      // The original admission was issued before durable request creation.
      // Re-attest it after all awaited file writes and immediately before the
      // first external worker effect. A revoked grant never launches a process.
      let authorized=false;
      try {
        authorized=await boundedTrustedHostCall(
          'ASYNC_DELIVERY_SIGNED_ORIGIN_REPLAY_TIMEOUT',
          ()=>protectedDeliveryOrigin.authorizeReplay(Object.freeze({
            operationId,requestId:input.requestId,correlationId,inputHash,
            originAdmissionId
          })),
          protectedOriginHostTimeoutMs)===true;
      } catch {}
      if(!authorized){
        await atomicJson(p.state,{
          ...baseState,status:'FAILED',updatedAt:new Date().toISOString(),
          failureCode:'OWNER_GRANT_REVOKED_BEFORE_EXECUTION'
        });
        throw new Error('ASYNC_DELIVERY_SIGNED_ORIGIN_ADMISSION_REVOKED');
      }
    }
    try {
      const worker = spawn(process.execPath, [resolvedWorker], {
        detached: true,
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'ignore']
      });
      const queued = { ...baseState, workerPid: worker.pid, updatedAt: new Date().toISOString() };
      await atomicJson(p.state, queued);
      worker.stdin.end(JSON.stringify(execution));
      if (continuation) observeWorkerExit(worker, operationId);
      worker.unref();
      return { operationId, requestId: input.requestId, correlationId, duplicate: false, status: 'QUEUED', continuationAttached: !!continuation };
    } catch (error) {
      await atomicJson(p.state, {
        ...baseState,
        status: 'FAILED',
        updatedAt: new Date().toISOString(),
        failureCode: 'WORKER_START_FAILED'
      });
      throw error;
    }
  }
  async function result(input) {
    const state = await status(input.operationId);
    const p = opPaths(input.operationId);
    let receipt = null;
    try { receipt = await readJson(p.result); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const tailBytes = boundedInt(input.tailBytes, 8192, 0, 32768);
    return {
      state,
      result: receipt,
      stdoutTail: await tailText(p.stdout, tailBytes),
      stderrTail: await tailText(p.stderr, tailBytes)
    };
  }
  async function discoverForDelivery() {
    if (!deliveryStore) return 0;
    let entries = [];
    try { entries = await readdir(operationsDir, { withFileTypes: true }); }
    catch (error) { if (error?.code === 'ENOENT') return 0; throw error; }
    let discovered = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !OP_RE.test(entry.name)) continue;
      discovered += 1;
      try {
        const state = await readStateProjection(opPaths(entry.name));
        if (state?.deliveryMode === 'transport-retry-only') continue;
      } catch {}
      deliveryTracked.add(entry.name);
    }
    return discovered;
  }
  async function reconcileDeliveriesOnce(limit = deliveryBatchSize) {
    if (!deliveryStore || deliveryClosed) return { checked: 0, pending: deliveryTracked.size };
    if (!deliveryDiscovered) {
      await discoverForDelivery();
      deliveryDiscovered = true;
    }
    if (deliveryClosed) return { checked: 0, pending: deliveryTracked.size };
    const ids = [...deliveryTracked].slice(0, boundedInt(limit, deliveryBatchSize, 1, 500));
    let checked = 0;
    for (const operationId of ids) {
      if (deliveryClosed) break;
      checked += 1;
      try {
        const state = await status(operationId, true);
        if (!TERMINAL.has(state.status)) {
          deliveryTracked.delete(operationId);
          deliveryTracked.add(operationId);
        }
      } catch {
        deliveryTracked.delete(operationId);
        deliveryTracked.add(operationId);
      }
    }
    return { checked, pending: deliveryTracked.size };
  }
  function reconcileDeliveries(limit = deliveryBatchSize) {
    if (!deliveryStore || deliveryClosed) return Promise.resolve({ checked: 0, pending: deliveryTracked.size });
    const run = () => reconcileDeliveriesOnce(limit);
    deliveryReconcilePromise = deliveryReconcilePromise.then(run, run);
    return deliveryReconcilePromise;
  }
  if (deliveryStore) {
    queueMicrotask(() => { reconcileDeliveries().catch(() => {}); });
    deliveryTimer = setInterval(() => { reconcileDeliveries().catch(() => {}); }, deliveryIntervalMs);
    deliveryTimer.unref?.();
  }
  if (continuationEnabled) queueMicrotask(() => { discoverContinuationOperations().catch(() => {}); });

  async function cancel(input, recheck = null) {
    const state = await status(input.operationId);
    // Even the already-terminal response exposes private status metadata.
    if(recheck)await recheck();
    if (TERMINAL.has(state.status)) return { operationId: input.operationId, status: state.status, alreadyTerminal: true };
    const p = opPaths(input.operationId);
    await writeFile(p.cancel, new Date().toISOString() + '\n', { encoding: 'utf8', mode: 0o600 });
    return { operationId: input.operationId, status: state.status, cancelRequested: true };
  }

  const authorizedOperationAccess=async(name,operationId)=>{
    if(!protectedDeliveryOrigin)return;
    // A UUID by itself is never permission to read or cancel a native result.
    if(typeof operationId!=='string'||!OP_RE.test(operationId))
      throw new Error('ASYNC_DELIVERY_SIGNED_ORIGIN_ACCESS_DENIED');
    const original=await reservationForOperation(operationId);
    if(!original||!REQUEST_RE.test(original.originAdmissionId??'')
      ||original.operationId!==operationId)
      throw new Error('ASYNC_DELIVERY_SIGNED_ORIGIN_ACCESS_DENIED');
    const authorized=await boundedTrustedHostCall(
      'ASYNC_DELIVERY_SIGNED_ORIGIN_ACCESS_TIMEOUT',
      ()=>protectedDeliveryOrigin.authorizeAccess(Object.freeze({
        name,operationId,originAdmissionId:original.originAdmissionId,
        requestId:original.requestId,
        inputHash:original.inputHash,
        correlationId:original.correlationId??original.requestId
      })),
      protectedOriginHostTimeoutMs);
    if(authorized!==true)
      throw new Error('ASYNC_DELIVERY_SIGNED_ORIGIN_ACCESS_DENIED');
  };

  return {
    definitions: asyncOperationDefinitions,
    status: () => ({
      enabled,
      backgroundFirst: policy.backgroundFirst !== false,
      originHostIntegration: {
        required: signedOriginRequired,
        callbacksConfigured: protectedDeliveryOrigin !== null,
        trustBoundary: protectedDeliveryOrigin !== null
          ? 'HOST_CALLBACKS_NOT_PROOF_OF_CHAT_ACK'
          : 'LEGACY_PROFILE_NOT_AUTHENTICATED_CHAT',
        originatingChatAckVerified: false
      },
      durable: true,
      requestIdempotency: true,
      rawArgumentsStored: false,
      maxOutputBytes,
      continuationRecovery:{
        scheduled:continuationRecoveryTimers.size,
        exhausted:continuationRecoveryExhausted.size,
        maxAttempts:continuationRecoveryMaxAttempts,
        nativeHostTimeoutMs:nativeHandoffHostTimeoutMs,
        originalHostTimeoutMs:protectedOriginHostTimeoutMs
      },
      stateRoot: root,
      deliveryIntegration: deliveryStore ? {
        enabled: true,
        reconcileIntervalMs: deliveryIntervalMs,
        reconcileBatch: deliveryBatchSize,
        tracked: deliveryTracked.size
      } : { enabled: false }
    }),
    reconcileDeliveries,
    close: async () => {
      continuationClosed = true;
      for(const operationId of [...continuationRecoveryTimers.keys()])stopRecovery(operationId);
      continuationRecoveryExhausted.clear();
      deliveryClosed = true;
      if (deliveryTimer) clearInterval(deliveryTimer);
      deliveryTimer = null;
      try { await deliveryReconcilePromise; } catch {}
    },
    execute: async (name, input) => {
      if (name === 'operation_start') return start(input);
      if (name === 'operation_status') {
        await authorizedOperationAccess(name,input.operationId);
        const data=await statusWithWait(input.operationId,input.waitMs ?? 0);
        await authorizedOperationAccess(name,input.operationId);
        return data;
      }
      if (name === 'operation_result') {
        await authorizedOperationAccess(name,input.operationId);
        const data=await result(input);
        await authorizedOperationAccess(name,input.operationId);
        return data;
      }
      if (name === 'operation_cancel') {
        await authorizedOperationAccess(name,input.operationId);
        return cancel(input,()=>authorizedOperationAccess(name,input.operationId));
      }
      throw new Error('unknown async operation tool');
    }
  };
}
