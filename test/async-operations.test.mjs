import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createAsyncOperationTools } from '../src/async-operations.mjs';
import { DeliveryStore } from '../src/delivery-store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'async-operation-fixture.mjs');
const worker = path.join(here, '..', 'tools', 'operation-worker.mjs');

// This suite exercises the detached worker without a Host execution grant.
// Do not let a package-level config.json (present in clean installs but absent
// from source checkouts) silently become the worker's ambient authority.
const priorWorkerConfig = process.env.REMOTE_COMMANDER_CONFIG;
const isolatedWorkerConfigDir = await mkdtemp(path.join(os.tmpdir(), 'rc-async-worker-config-'));
process.env.REMOTE_COMMANDER_CONFIG = path.join(isolatedWorkerConfigDir, 'intentionally-absent.json');
after(async () => {
  if (priorWorkerConfig === undefined) delete process.env.REMOTE_COMMANDER_CONFIG;
  else process.env.REMOTE_COMMANDER_CONFIG = priorWorkerConfig;
  await rm(isolatedWorkerConfigDir, { recursive: true, force: true });
});

async function waitFor(manager, operationId, terminal = ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'UNCERTAIN'], timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = await manager.execute('operation_status', { operationId });
    if (terminal.includes(lastState.status)) return lastState;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`operation did not finish within ${timeoutMs}ms: status=${lastState?.status ?? 'unknown'} workerPid=${lastState?.workerPid ?? 'unknown'}`);
}

async function waitForProcessExit(pid, timeoutMs = 30000) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('operation worker did not exit');
}

async function waitForFile(target, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await stat(target); return; }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('fixture did not reach ready state');
}

async function withManager(fn, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rc-async-'));
  const manager = createAsyncOperationTools({
    config: {
      instance: { profile: 'test' },
      asyncOperations: { enabled: true, stateDir: path.join(root, 'state'), maxOutputBytes: 65536, ...overrides }
    },
    workerPath: worker,
    prepare: async (_tool, args) => ({
      file: process.execPath,
      args: [fixture, ...args.argv],
      cwd: root,
      timeoutMs: args.timeoutMs ?? 5000,
      outputLimit: args.outputLimit ?? 65536
    })
  });
  try { await fn({ manager, root }); } finally { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}

test('lost acknowledgement retry reuses one operation and one external effect', async () => {
  await withManager(async ({ manager, root }) => {
    const effect = path.join(root, 'effect.txt');
    const input = { requestId: 'retry-1', tool: 'run_project_command', arguments: { argv: ['effect', effect, '250'] } };
    const first = await manager.execute('operation_start', input);
    const retry = await manager.execute('operation_start', input);
    assert.equal(retry.operationId, first.operationId);
    assert.equal(retry.duplicate, true);
    await waitFor(manager, first.operationId);
    assert.equal(await readFile(effect, 'utf8'), 'x');
  });
});

test('same requestId with changed inputs fails closed', async () => {
  await withManager(async ({ manager }) => {
    await manager.execute('operation_start', { requestId: 'same-id', tool: 'run_project_command', arguments: { argv: ['sleep', '30', 'a'] } });
    await assert.rejects(
      manager.execute('operation_start', { requestId: 'same-id', tool: 'run_project_command', arguments: { argv: ['sleep', '30', 'b'] } }),
      /REQUEST_ID_CONFLICT/
    );
  });
});

test('large output is file-backed and inline result stays bounded', async () => {
  await withManager(async ({ manager }) => {
    const started = await manager.execute('operation_start', {
      requestId: 'large-1',
      tool: 'run_project_command',
      arguments: { argv: ['large', '200000'], outputLimit: 65536 }
    });
    await waitFor(manager, started.operationId);
    const result = await manager.execute('operation_result', { operationId: started.operationId, tailBytes: 1024 });
    assert.equal(result.state.status, 'SUCCEEDED');
    assert.equal(result.result.stdout.capturedBytes, 65536);
    assert.equal(result.result.stdout.totalBytes, 200000);
    assert.equal(result.result.stdout.sha256, createHash('sha256').update('x'.repeat(200000)).digest('hex'));
    assert.equal(result.result.stdout.truncated, true);
    assert.equal(Buffer.byteLength(result.stdoutTail), 1024);
    assert.ok(JSON.stringify(result).length < 10000);
  });
});

test('child exit completes operation while inherited-stdio holder is still alive', async () => {
  await withManager(async ({ manager, root }) => {
    const ready = path.join(root, 'linger-stdio.ready');
    const started = await manager.execute('operation_start', {
      requestId: 'linger-stdio-1',
      tool: 'run_project_command',
      arguments: { argv: ['linger-stdio', 'parent-done', ready, '60000'], timeoutMs: 30000 }
    });
    await waitForFile(ready, 20000);
    const holderPid = Number((await readFile(ready, 'utf8')).trim());
    assert.equal(Number.isSafeInteger(holderPid) && holderPid > 0, true, 'fixture must expose inherited-stdio holder pid');
    try {
      const state = await waitFor(manager, started.operationId, undefined, 20000);
      assert.equal(state.status, 'SUCCEEDED');
      assert.doesNotThrow(() => process.kill(holderPid, 0), 'operation must complete while inherited-stdio holder remains alive');
      const result = await manager.execute('operation_result', { operationId: started.operationId, tailBytes: 1024 });
      assert.equal(result.result.outputComplete, false);
      assert.equal(result.stdoutTail, 'parent-done');
    } finally {
      try { process.kill(holderPid); } catch {}
      await waitForProcessExit(holderPid, 5000).catch(()=>{});
    }
  });
});

test('status tolerates a bounded transient state-projection replacement gap', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rc-async-state-gap-'));
  const stateRoot = path.join(root, 'state');
  const config = { instance: { profile: 'test' }, asyncOperations: { enabled: true, stateDir: stateRoot, maxOutputBytes: 65536 } };
  const prepare = async (_tool, args) => ({ file: process.execPath, args: [fixture, ...args.argv], cwd: root, timeoutMs: 5000, outputLimit: 65536 });
  try {
    const firstManager = createAsyncOperationTools({ config, prepare, workerPath: worker });
    const started = await firstManager.execute('operation_start', {
      requestId: 'state-gap-1',
      tool: 'run_project_command',
      arguments: { argv: ['sleep', '120', 'stable-before-gap'] }
    });
    const completed = await waitFor(firstManager, started.operationId);
    assert.equal(completed.status, 'SUCCEEDED');

    const statePath = path.join(stateRoot, 'operations', started.operationId, 'state.json');
    const heldPath = statePath + '.held';
    await rename(statePath, heldPath);

    const secondManager = createAsyncOperationTools({ config, prepare, workerPath: worker });
    const pendingRead = secondManager.execute('operation_status', { operationId: started.operationId });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await rename(heldPath, statePath);

    const observed = await pendingRead;
    assert.equal(observed.operationId, started.operationId);
    assert.equal(observed.status, 'SUCCEEDED');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test('a new manager instance can recover status and result while detached work continues', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rc-async-restart-'));
  const config = { instance: { profile: 'test' }, asyncOperations: { enabled: true, stateDir: path.join(root, 'state'), maxOutputBytes: 65536 } };
  const prepare = async (_tool, args) => ({ file: process.execPath, args: [fixture, ...args.argv], cwd: root, timeoutMs: 5000, outputLimit: 65536 });
  try {
    const firstManager = createAsyncOperationTools({ config, prepare, workerPath: worker });
    const started = await firstManager.execute('operation_start', {
      requestId: 'restart-1',
      tool: 'run_project_command',
      arguments: { argv: ['sleep', '250', 'recovered'] }
    });
    const secondManager = createAsyncOperationTools({ config, prepare, workerPath: worker });
    await waitFor(secondManager, started.operationId);
    const result = await secondManager.execute('operation_result', { operationId: started.operationId, tailBytes: 1024 });
    assert.equal(result.state.status, 'SUCCEEDED');
    assert.equal(result.stdoutTail, 'recovered');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test('cancel request is durable and stops Commander-owned work', async () => {
  await withManager(async ({ manager }) => {
    const started = await manager.execute('operation_start', {
      requestId: 'cancel-1',
      tool: 'run_project_command',
      arguments: { argv: ['sleep', '5000', 'late'], timeoutMs: 8000 }
    });
    await manager.execute('operation_cancel', { operationId: started.operationId });
    const state = await waitFor(manager, started.operationId);
    assert.ok(['CANCELLED','UNCERTAIN'].includes(state.status));
    assert.equal(state.cancelRequested, true);
    if(state.status==='UNCERTAIN'){
      assert.equal(state.failureCode, 'DEADLINE_EXCEEDED_WITHOUT_FINAL_RECEIPT');
      assert.equal(Number.isSafeInteger(state.workerPid)&&state.workerPid>0, true);
      await waitForProcessExit(state.workerPid, 30000);
      if(Number.isSafeInteger(state.childPid)&&state.childPid>0) await waitForProcessExit(state.childPid, 30000);
    }
    const result = await manager.execute('operation_result', { operationId: started.operationId, tailBytes: 1024 });
    assert.equal(result.stdoutTail.includes('late'), false);
  });
});


test('validation failure happens before request reservation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rc-async-validate-'));
  const stateDir = path.join(root, 'state');
  const manager = createAsyncOperationTools({
    config: { instance: { profile: 'test' }, asyncOperations: { enabled: true, stateDir } },
    workerPath: worker,
    prepare: async () => { throw new Error('validation rejected'); }
  });
  try {
    await assert.rejects(
      manager.execute('operation_start', {
        requestId: 'invalid-before-reserve',
        tool: 'run_project_command',
        arguments: { bad: true }
      }),
      /validation rejected/
    );
    const requests = await readdir(path.join(stateDir, 'requests')).catch((error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    assert.deepEqual(requests, []);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});


test('dead-worker reconciliation adopts an exact final receipt instead of overwriting it UNCERTAIN', async () => {
  await withManager(async ({ manager, root }) => {
    const started = await manager.execute('operation_start', {
      requestId: 'receipt-race-1',
      tool: 'run_project_command',
      arguments: { argv: ['sleep', '40', 'receipt-wins'] }
    });
    const final = await waitFor(manager, started.operationId, ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'UNCERTAIN'], 30000);
    assert.equal(final.status, 'SUCCEEDED');

    const statePath = path.join(root, 'state', 'operations', started.operationId, 'state.json');
    const stale = JSON.parse(await readFile(statePath, 'utf8'));
    stale.status = 'UNCERTAIN';
    stale.workerPid = 2147483646;
    delete stale.finishedAt;
    delete stale.exitCode;
    stale.failureCode = 'WORKER_EXCEPTION';
    await writeFile(statePath, JSON.stringify(stale, null, 2) + '\n', 'utf8');

    const recovered = await manager.execute('operation_status', { operationId: started.operationId });
    assert.equal(recovered.status, 'SUCCEEDED');
    assert.equal(recovered.recoveredFromReceipt, true);
  });
});


test('dead worker without receipt becomes UNCERTAIN after a bounded final-receipt grace instead of waiting for a long deadline', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rc-async-dead-pid-'));
  const stateDir = path.join(root, 'state');
  const manager = createAsyncOperationTools({
    config: { instance: { profile: 'test' }, asyncOperations: { enabled: true, stateDir } },
    workerPath: worker,
    prepare: async () => { throw new Error('prepare must not run for status'); }
  });
  try {
    const operationId = randomUUID();
    const operationDir = path.join(stateDir, 'operations', operationId);
    await mkdir(operationDir, { recursive: true });
    const statePath = path.join(operationDir, 'state.json');
    const nowMs = Date.now();
    const now = new Date(nowMs - 5000).toISOString();
    const state = {
      schema: 1,
      operationId,
      requestId: 'dead-pid-before-deadline',
      inputHash: 'a'.repeat(64),
      tool: 'run_project_command',
      status: 'RUNNING',
      createdAt: now,
      updatedAt: now,
      timeoutMs: 24 * 60 * 60 * 1000,
      deadlineAt: new Date(nowMs + 24 * 60 * 60 * 1000).toISOString(),
      workerPid: 2147483646,
      childPid: null
    };
    await writeFile(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');

    const observed = await manager.execute('operation_status', { operationId });
    assert.equal(observed.status, 'UNCERTAIN');
    assert.equal(observed.failureCode, 'WORKER_MISSING_WITHOUT_FINAL_RECEIPT');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test('freshly exited worker projection gets a short receipt grace and is not downgraded immediately', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rc-async-dead-grace-'));
  const stateDir = path.join(root, 'state');
  const manager = createAsyncOperationTools({
    config: { instance: { profile: 'test' }, asyncOperations: { enabled: true, stateDir } },
    workerPath: worker,
    prepare: async () => { throw new Error('prepare must not run for status'); }
  });
  try {
    const operationId = randomUUID();
    const operationDir = path.join(stateDir, 'operations', operationId);
    await mkdir(operationDir, { recursive: true });
    const now = new Date().toISOString();
    await writeFile(path.join(operationDir, 'state.json'), JSON.stringify({
      schema:1,operationId,requestId:'fresh-dead-grace',inputHash:'f'.repeat(64),
      tool:'run_project_command',status:'RUNNING',createdAt:now,updatedAt:now,
      timeoutMs:86400000,deadlineAt:new Date(Date.now()+86400000).toISOString(),
      workerPid:2147483646,childPid:null
    }, null, 2)+'\n','utf8');
    const observed=await manager.execute('operation_status',{operationId});
    assert.equal(observed.status,'RUNNING');
  } finally {
    await manager.close?.();
    await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:50});
  }
});

test('stale QUEUED projection fail-closes after scheduling grace even when PID is alive', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rc-async-stale-queued-'));
  const stateDir = path.join(root, 'state');
  const manager = createAsyncOperationTools({
    config: { instance: { profile: 'test' }, asyncOperations: { enabled: true, stateDir } },
    workerPath: worker,
    prepare: async () => { throw new Error('prepare must not run for status'); }
  });
  try {
    const operationId = randomUUID();
    const operationDir = path.join(stateDir, 'operations', operationId);
    await mkdir(operationDir, { recursive: true });
    const now = Date.now();
    const state = {
      schema: 1, operationId, requestId: 'stale-queued', correlationId: 'stale-queued',
      inputHash: 'd'.repeat(64), tool: 'copy_path', status: 'QUEUED',
      createdAt: new Date(now - 120000).toISOString(), updatedAt: new Date(now - 120000).toISOString(),
      timeoutMs: 24 * 60 * 60 * 1000, deadlineAt: new Date(now + 23 * 60 * 60 * 1000).toISOString(),
      workerPid: process.pid, childPid: null, continuation: null
    };
    await writeFile(path.join(operationDir, 'state.json'), JSON.stringify(state, null, 2) + '\n', 'utf8');
    const observed = await manager.execute('operation_status', { operationId });
    assert.equal(observed.status, 'UNCERTAIN');
    assert.equal(observed.failureCode, 'QUEUED_WORKER_STALLED_WITHOUT_FINAL_RECEIPT');
  } finally {
    await manager.close?.();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});


test('reconciliation does not downgrade a live worker whose execution budget started after queue delay', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rc-async-live-worker-grace-'));
  const stateDir = path.join(root, 'state');
  const manager = createAsyncOperationTools({
    config: { instance: { profile: 'test' }, asyncOperations: { enabled: true, stateDir } },
    workerPath: worker,
    prepare: async () => { throw new Error('prepare must not run for status'); }
  });
  try {
    const operationId = randomUUID();
    const operationDir = path.join(stateDir, 'operations', operationId);
    await mkdir(operationDir, { recursive: true });
    const now = Date.now();
    const state = {
      schema: 1,
      operationId,
      requestId: 'live-worker-grace',
      correlationId: 'live-worker-grace',
      inputHash: 'b'.repeat(64),
      tool: 'run_project_command',
      status: 'RUNNING',
      createdAt: new Date(now - 20000).toISOString(),
      updatedAt: new Date(now - 1000).toISOString(),
      startedAt: new Date(now - 1000).toISOString(),
      timeoutMs: 5000,
      deadlineAt: new Date(now - 10000).toISOString(),
      workerPid: process.pid,
      childPid: null,
      continuation: null
    };
    await writeFile(path.join(operationDir, 'state.json'), JSON.stringify(state, null, 2) + '\n', 'utf8');
    const observed = await manager.execute('operation_status', { operationId });
    assert.equal(observed.status, 'RUNNING');
    assert.equal(observed.failureCode, undefined);
  } finally {
    await manager.close?.();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test('reconciliation fail-closes a still-live worker after the bounded finalization hard deadline', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rc-async-live-worker-hard-deadline-'));
  const stateDir = path.join(root, 'state');
  const manager = createAsyncOperationTools({
    config: { instance: { profile: 'test' }, asyncOperations: { enabled: true, stateDir } },
    workerPath: worker,
    prepare: async () => { throw new Error('prepare must not run for status'); }
  });
  try {
    const operationId = randomUUID();
    const operationDir = path.join(stateDir, 'operations', operationId);
    await mkdir(operationDir, { recursive: true });
    const now = Date.now();
    const state = {
      schema: 1, operationId, requestId: 'live-worker-hard-deadline', correlationId: 'live-worker-hard-deadline',
      inputHash: 'c'.repeat(64), tool: 'run_project_command', status: 'RUNNING',
      createdAt: new Date(now - 120000).toISOString(), updatedAt: new Date(now - 120000).toISOString(),
      startedAt: new Date(now - 120000).toISOString(), timeoutMs: 5000,
      deadlineAt: new Date(now - 110000).toISOString(), workerPid: process.pid, childPid: null, continuation: null
    };
    await writeFile(path.join(operationDir, 'state.json'), JSON.stringify(state, null, 2) + '\n', 'utf8');
    const observed = await manager.execute('operation_status', { operationId });
    assert.equal(observed.status, 'UNCERTAIN');
    assert.equal(observed.failureCode, 'DEADLINE_EXCEEDED_WITHOUT_FINAL_RECEIPT');
  } finally {
    await manager.close?.();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test('terminal operation receipts backfill exactly once into durable delivery after restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rc-async-delivery-'));
  let first = null, second = null, delivery = null;
  try {
    const config = {
      instance: { profile: 'delivery-test' },
      asyncOperations: { enabled: true, stateDir: path.join(root, 'ops'), maxOutputBytes: 1024 * 1024 }
    };
    const prepare = async () => ({
      file: process.execPath,
      args: ['-e', 'process.stdout.write("done")'],
      cwd: root,
      timeoutMs: 5000,
      outputLimit: 1024 * 1024
    });
    first = createAsyncOperationTools({ config, prepare });
    const started = await first.execute('operation_start', {
      requestId: 'delivery-request-1',
      correlationId: 'chat-a',
      tool: 'run_project_command',
      arguments: { argv: ['done'] }
    });
    // The completion receipt is committed before the detached worker's final
    // state projection. A second manager must not race the old worker's last
    // atomic state write and mistake timestamp movement for duplicate backfill.
    const terminal = await waitFor(first, started.operationId);
    assert.equal(terminal.status, 'SUCCEEDED');
    await waitForProcessExit(terminal.workerPid);
    await first.close?.();
    first = null;

    delivery = new DeliveryStore({ directory: path.join(root, 'delivery'), scope: 'profile-a' });
    second = createAsyncOperationTools({ config, prepare, deliveryStore: delivery });
    await second.reconcileDeliveries(500);
    const listed = delivery.list({ correlationId: 'chat-a', includeDelivered: true });
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].source, 'operation');
    assert.equal(listed.items[0].sourceId, started.operationId);
    assert.equal(listed.items[0].kind, 'COMPLETED');
    const statePath = path.join(root, 'ops', 'operations', started.operationId, 'state.json');
    const afterFirstReconcile = (await stat(statePath)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const secondPass = await second.reconcileDeliveries(500);
    assert.equal(secondPass.checked, 0);
    assert.equal(delivery.list({ correlationId: 'chat-a', includeDelivered: true }).items.length, 1);
    assert.equal((await stat(statePath)).mtimeMs, afterFirstReconcile);
  } finally {
    try { await first?.close?.(); } catch {}
    try { await second?.close?.(); } catch {}
    try { delivery?.close(); } catch {}
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test('corrupt terminal projection recovers from exact reservation and receipt without replay', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rc-async-corrupt-projection-'));
  let first = null, second = null, delivery = null;
  try {
    const config = {
      instance: { profile: 'corrupt-projection-test' },
      asyncOperations: { enabled: true, stateDir: path.join(root, 'ops'), maxOutputBytes: 1024 * 1024 }
    };
    const prepare = async () => ({
      file: process.execPath,
      args: ['-e', 'process.stdout.write("done")'],
      cwd: root,
      timeoutMs: 5000,
      outputLimit: 1024 * 1024
    });
    first = createAsyncOperationTools({ config, prepare });
    const started = await first.execute('operation_start', {
      requestId: 'corrupt-projection-request-1',
      correlationId: 'chat-corrupt-projection',
      tool: 'run_project_command',
      arguments: { argv: ['done'] }
    });
    const terminal = await waitFor(first, started.operationId);
    await waitForProcessExit(terminal.workerPid);
    await first.close?.();
    first = null;

    const operationDir = path.join(root, 'ops', 'operations', started.operationId);
    const statePath = path.join(operationDir, 'state.json');
    const originalState = await readFile(statePath);
    const zeros = Buffer.alloc(originalState.length);
    await writeFile(statePath, zeros);

    delivery = new DeliveryStore({ directory: path.join(root, 'delivery'), scope: 'profile-corrupt' });
    second = createAsyncOperationTools({ config, prepare, deliveryStore: delivery });
    await second.reconcileDeliveries(500);

    const listed = delivery.list({ correlationId: 'chat-corrupt-projection', includeDelivered: true });
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].sourceId, started.operationId);
    assert.equal(listed.items[0].kind, 'COMPLETED');
    const repaired = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(repaired.status, 'SUCCEEDED');
    assert.equal(repaired.recoveredFromReceipt, true);
    assert.equal(repaired.recoveredFromCorruptProjection, true);
    assert.equal(repaired.correlationId, 'chat-corrupt-projection');
    const backups = (await readdir(operationDir)).filter((name) => name.startsWith('state.corrupt-') && name.endsWith('.bin'));
    assert.equal(backups.length, 1);
    assert.deepEqual(await readFile(path.join(operationDir, backups[0])), zeros);
    const secondPass = await second.reconcileDeliveries(500);
    assert.equal(secondPass.checked, 0);
  } finally {
    try { await first?.close?.(); } catch {}
    try { await second?.close?.(); } catch {}
    try { delivery?.close(); } catch {}
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test('corrupt terminal projection is not repaired when receipt and reservation hashes differ', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rc-async-corrupt-mismatch-'));
  let first = null, second = null, delivery = null;
  try {
    const config = {
      instance: { profile: 'corrupt-mismatch-test' },
      asyncOperations: { enabled: true, stateDir: path.join(root, 'ops'), maxOutputBytes: 1024 * 1024 }
    };
    const prepare = async () => ({
      file: process.execPath, args: ['-e', 'process.stdout.write("done")'], cwd: root,
      timeoutMs: 5000, outputLimit: 1024 * 1024
    });
    first = createAsyncOperationTools({ config, prepare });
    const started = await first.execute('operation_start', {
      requestId: 'corrupt-mismatch-request-1', correlationId: 'chat-corrupt-mismatch',
      tool: 'run_project_command', arguments: { argv: ['done'] }
    });
    const terminal = await waitFor(first, started.operationId, ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'UNCERTAIN'], 30000);
    await waitForProcessExit(terminal.workerPid, 30000);
    await first.close?.();
    first = null;

    const operationDir = path.join(root, 'ops', 'operations', started.operationId);
    const statePath = path.join(operationDir, 'state.json');
    const resultPath = path.join(operationDir, 'result.json');
    const originalState = await readFile(statePath);
    const receipt = JSON.parse(await readFile(resultPath, 'utf8'));
    receipt.inputHash = 'f'.repeat(64);
    await writeFile(resultPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
    const zeros = Buffer.alloc(originalState.length);
    await writeFile(statePath, zeros);

    delivery = new DeliveryStore({ directory: path.join(root, 'delivery'), scope: 'profile-corrupt-mismatch' });
    second = createAsyncOperationTools({ config, prepare, deliveryStore: delivery });
    await second.reconcileDeliveries(1);
    assert.equal(delivery.list({ correlationId: 'chat-corrupt-mismatch', includeDelivered: true }).items.length, 0);
    assert.deepEqual(await readFile(statePath), zeros);
    assert.equal(second.status().deliveryIntegration.tracked, 1);
  } finally {
    try { await first?.close?.(); } catch {}
    try { await second?.close?.(); } catch {}
    try { delivery?.close(); } catch {}
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test('same async requestId with a changed correlation fails closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rc-async-correlation-'));
  try {
    const config = { asyncOperations: { enabled: true, stateDir: path.join(root, 'ops') } };
    const prepare = async () => ({
      file: process.execPath, args: ['-e', 'setTimeout(()=>{},50)'], cwd: root,
      timeoutMs: 1000, outputLimit: 65536
    });
    const manager = createAsyncOperationTools({ config, prepare });
    const input = { requestId: 'same-correlation-request', correlationId: 'chat-a', tool: 'run_project_command', arguments: {} };
    await manager.execute('operation_start', input);
    await assert.rejects(
      manager.execute('operation_start', { ...input, correlationId: 'chat-b' }),
      /REQUEST_ID_CONFLICT/
    );
    await manager.close?.();
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});


test('transport-retry-only operations remain durable without becoming actionable delivery across restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rc-async-transport-receipt-'));
  let first = null, second = null, delivery = null;
  try {
    const config = {
      instance: { profile: 'transport-receipt-test' },
      asyncOperations: { enabled: true, stateDir: path.join(root, 'ops'), maxOutputBytes: 1024 * 1024 }
    };
    const prepare = async () => ({
      file: process.execPath,
      args: ['-e', 'process.stdout.write("done")'],
      cwd: root,
      timeoutMs: 5000,
      outputLimit: 1024 * 1024
    });
    delivery = new DeliveryStore({ directory: path.join(root, 'delivery'), scope: 'profile-transport' });
    first = createAsyncOperationTools({ config, prepare, deliveryStore: delivery });
    const transportId='transport-'+'c'.repeat(64);
    const started = await first.execute('operation_start', {
      requestId: transportId,
      correlationId: transportId,
      __deliveryMode: 'transport-retry-only',
      tool: 'run_project_command',
      arguments: { argv: ['done'] }
    });
    const terminal = await waitFor(first, started.operationId);
    assert.equal(terminal.status,'SUCCEEDED');
    assert.equal(terminal.deliveryMode,'transport-retry-only');
    assert.equal(delivery.health().pending,0);
    assert.equal(first.status().deliveryIntegration.tracked,0);

    const statePath=path.join(root,'ops','operations',started.operationId,'state.json');
    const persisted=JSON.parse(await readFile(statePath,'utf8'));
    assert.equal(persisted.deliveryMode,'transport-retry-only');
    await first.close?.(); first=null;

    second = createAsyncOperationTools({ config, prepare, deliveryStore: delivery });
    await second.reconcileDeliveries(500);
    assert.equal(second.status().deliveryIntegration.tracked,0);
    assert.equal(delivery.list({correlationId:transportId,includeDelivered:true}).items.length,0);

    const explicit = await second.execute('operation_start', {
      requestId:'explicit-delivery-operation',
      correlationId:'chat-explicit-operation',
      tool:'run_project_command',
      arguments:{argv:['done']}
    });
    const explicitTerminal=await waitFor(second,explicit.operationId);
    assert.equal(explicitTerminal.status,'SUCCEEDED');
    const listed=delivery.list({correlationId:'chat-explicit-operation',includeDelivered:true});
    assert.equal(listed.items.length,1);
    assert.equal(listed.items[0].source,'operation');
    assert.equal(delivery.health().pending,1);
  } finally {
    try { await first?.close?.(); } catch {}
    try { await second?.close?.(); } catch {}
    try { delivery?.close(); } catch {}
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});
