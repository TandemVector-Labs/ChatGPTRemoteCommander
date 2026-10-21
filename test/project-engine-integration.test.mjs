import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWorkflowTools } from '../src/workflow-tools.mjs';
import { createProjectEngine } from '../src/project-engine.mjs';
import { validateJsonSchema } from '../src/schema-validator.mjs';
import { listDirectory, readText, writeText } from '../src/tools-v0.3.mjs';
import { writeAnyFile } from '../src/power-tools-v0.3.mjs';

const proposal = (tool, args) => ({ action: 'call', tool, argumentsJson: JSON.stringify(args), summary: 'Perform one approved project step' });
const delegate = (artifact = 'worker-draft.txt', brief = 'Create one bounded artifact') => ({ action: 'delegate', tool: '', argumentsJson: JSON.stringify({ artifact, brief }), summary: 'Delegate one bounded artifact worker' });
const definitions = {
  write_text: { name: 'write_text', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } },
  read_text: { name: 'read_text', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  list_directory: { name: 'list_directory', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false } }
};
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(25);
  }
  assert.fail('Timed out waiting for bounded integration result');
}
function makeFixture({ root, planner, scheduler = false, runner = {}, afterDispatch } = {}) {
  root ??= fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rc-engine-integration-')));
  const config = {
    allowedRoots: [root], maxWriteBytes: 524288, maxReadBytes: 524288, auditLog: path.join(root, 'audit.jsonl'),
    durableWorkflows: {
      enabled: true, directory: path.join(root, 'state'), executionTools: Object.keys(definitions),
      scheduler: { enabled: scheduler, intervalMs: 1000, oneWriterPerRoot: true },
      runner: { enabled: true, allowedTools: Object.keys(definitions), maxActions: 10, maxDurationMs: 30000, ...runner }
    }
  };
  let calls = 0, plans = 0;
  const api = createWorkflowTools({
    config, roots: [root], device: 'integration-fixture', configSha256: '7'.repeat(64),
    lookup: name => definitions[name], validateSchema: validateJsonSchema,
    planner: { plan: async (...args) => { plans++; return planner(...args); }, describe: () => ({ kind: 'integration-fixture' }) },
    dispatch: async (name, args, workflow) => {
      calls++;
      // The same project-root restriction as the real server dispatch adapter.
      const ctx = { roots: [workflow.root], auditLog: config.auditLog, config: { ...config, allowedRoots: [workflow.root], powerMode: { fullFilesystem: false } } };
      const result = name === 'write_text' ? await writeText(ctx, args)
        : name === 'read_text' ? await readText(ctx, args) : await listDirectory(ctx, args);
      if (afterDispatch) await afterDispatch(name, args, result);
      return result;
    }
  });
  return {
    root, api, get calls() { return calls; }, get plans() { return plans; },
    create: (id = 'project', steps = [{ id: 'write', title: 'Produce result evidence' }]) => api.execute('workflow_create', { id, root, goal: 'Produce the approved project artifact', acceptance: ['Artifact contains verified output'], steps }),
    async start({ id = 'project', runId = 'run-one', checks, ...rest } = {}) {
      const state = (await api.execute('workflow_get', { id })).state;
      return api.execute('workflow_run_start', { id, runId, expectedRevision: state.revision, checks: checks ?? [{ criterion: 0, type: 'text_includes', path: 'result.txt', text: 'verified output' }], ...rest });
    },
    tick: () => api.execute('workflow_run_tick', { runId: 'run-one' }),
    state: async (id = 'project') => (await api.execute('workflow_get', { id })).state,
    status: () => api.execute('workflow_run_status', { runId: 'run-one' }),
    async dispose() { await api.close(); fs.rmSync(root, { recursive: true, force: true }); }
  };
}

async function claimWorker(root) {
  const release = deferred();
  process.on('message', message => { if (message?.kind === 'release') release.resolve(); });
  const fixture = makeFixture({ root, planner: async () => {
    process.send({ kind: 'planning' });
    await release.promise;
    return proposal('write_text', { path: 'result.txt', content: 'verified output' });
  } });
  try { process.send({ kind: 'result', result: await fixture.tick() }); }
  catch (error) { process.send({ kind: 'error', message: String(error.message) }); process.exitCode = 1; }
  finally { await fixture.api.close(); process.disconnect(); }
}

if (process.argv[2] === '--claim-worker') {
  await claimWorker(process.argv[3]);
} else {
  test('automatic scheduler never plans an unenrolled workflow and completes only after explicit enrollment', { timeout: 9000 }, async () => {
    const fixture = makeFixture({ scheduler: true, runner: { autoTick: true }, planner: async () => proposal('write_text', { path: 'result.txt', content: 'verified output' }) });
    try {
      await fixture.create();
      await sleep(1200); // An actual timer cycle, not just the manual scheduler API.
      assert.equal(fixture.plans, 0);
      assert.equal(fixture.calls, 0);
      assert.equal(fs.existsSync(path.join(fixture.root, 'result.txt')), false);
      assert.deepEqual((await fixture.api.execute('workflow_run_status', {})).runs, []);
      await fixture.start();
      const final = await until(async () => { const current = await fixture.status(); return current.status === 'COMPLETED' ? current : null; });
      assert.equal(final.actions, 1);
      assert.equal(fixture.plans, 1);
      assert.equal(fixture.calls, 1);
      assert.equal((await fixture.state()).lifecycleState, 'COMPLETED');
    } finally { await fixture.dispose(); }
  });

  for (const earlyWake of [false,true]) test(`deadline aborts an abort-aware planner before any filesystem effect (early wake=${earlyWake})`, { timeout: 6000 }, async t => {
    let aborted = false;
    const fixture = makeFixture({ planner: async (_, { signal }) => new Promise((resolve, reject) => {
      const stop = () => { aborted = true; reject(Object.assign(new Error('Planner interrupted'), { code: 'PLANNER_ABORTED' })); };
      if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
    }) });
    try {
      await fixture.create(); const started = await fixture.start({ durationMs: 1000 });
      let timerCalls=0;
      if(earlyWake){
        const nativeTimeout=globalThis.setTimeout;
        t.mock.method(globalThis,'setTimeout',(callback,delay,...args)=>{
          timerCalls++;
          return nativeTimeout(callback,Math.min(delay,5),...args);
        });
      }
      const result = await fixture.tick();
      if(earlyWake)assert.ok(
        timerCalls>1 || Date.now()>=started.deadline,
        'a genuinely early deadline timer must be rescheduled; a late callback may abort directly'
      );
      // An already-expired run can fail closed before entering its planner.
      // Require AbortSignal only if the planner actually started.
      if (fixture.plans === 0) {
        assert.equal(aborted, false);
        assert.ok(Date.now() >= started.deadline);
        assert.equal(result.attempts, 0);
      } else {
        assert.equal(fixture.plans, 1);
        assert.equal(aborted, true);
        assert.equal(result.attempts, 1);
      }
      assert.equal(result.status, 'EXHAUSTED');
      assert.equal(result.lastCode, 'PROJECT_DEADLINE_EXHAUSTED');
      assert.equal(fixture.calls, 0);
      assert.equal(fs.existsSync(path.join(fixture.root, 'result.txt')), false);
      assert.equal((await fixture.tick()).skipped, true);
    } finally { await fixture.dispose(); }
  });

  test('pre-expired deadline refuses planner and all filesystem effects', { timeout: 6000 }, async () => {
    const fixture = makeFixture({ planner: async () => { throw Error('Expired run must not plan'); } });
    try {
      await fixture.create();
      const started = await fixture.start({ durationMs: 1000 });
      await sleep(Math.max(0, started.deadline - Date.now() + 25));
      const result = await fixture.tick();
      assert.equal(result.status, 'EXHAUSTED');
      assert.equal(result.lastCode, 'PROJECT_DEADLINE_EXHAUSTED');
      assert.equal(result.attempts, 0);
      assert.equal(fixture.plans, 0);
      assert.equal(fixture.calls, 0);
      assert.equal(fs.existsSync(path.join(fixture.root, 'result.txt')), false);
    } finally { await fixture.dispose(); }
  });

  test('cancel during an effect preserves its root lease and cancellation after the receipt', { timeout: 6000 }, async () => {
    const release = deferred();
    let effectEntered = false;
    const fixture = makeFixture({ planner: async () => proposal('write_text', { path: 'result.txt', content: 'verified output' }), afterDispatch: async () => { effectEntered = true; await release.promise; } });
    let pending, tickSettled = false;
    try {
      await fixture.create(); await fixture.create('other'); await fixture.start();
      pending = fixture.tick();
      // Never await an unsignalled effect gate without a bounded failure.
      void pending.finally(() => { tickSettled = true; }).catch(() => {});
      await until(() => {
        if (tickSettled && !effectEntered) assert.fail('PROJECT_EFFECT_NOT_DISPATCHED');
        return effectEntered;
      }, 3500);
      const running = await fixture.state();
      await fixture.api.execute('workflow_control', { id: 'project', expectedRevision: running.revision, action: 'cancel', reason: 'User cancelled during the pending effect receipt' });
      const other = await fixture.state('other');
      await assert.rejects(fixture.api.execute('workflow_call', { id: 'other', expectedRevision: other.revision, stepId: 'write', tool: 'write_text', arguments: { path: 'other.txt', content: 'must not write' } }), /WORKFLOW_ROOT_LEASED/u);
      assert.equal(fixture.calls, 1);
      assert.equal(fs.existsSync(path.join(fixture.root, 'other.txt')), false);
      release.resolve();
      const result = await pending;
      assert.equal(result.status, 'CANCELLED');
      assert.equal(result.lastCode, 'PROJECT_CANCELLED');
      const cancelled = await fixture.state();
      assert.equal(cancelled.control.intent, 'CANCELLED');
      assert.equal(cancelled.lifecycleState, 'CANCELLED');
      assert.equal(cancelled.steps[0].status, 'recorded');
      const operations = (await fixture.api.execute('workflow_operations', { id: 'project' })).operations;
      assert.equal(operations.length, 1);
      assert.equal(operations[0].status, 'EXECUTED');
      assert.equal((await fixture.tick()).skipped, true);
    } finally {
      release.resolve();
      try { if (pending) await pending; }
      finally { await fixture.dispose(); }
    }
  });

  test('nested evidence paths finalize with platform separators and independently verified hashes', async () => {
    const nested = path.join('reports', 'nested', 'result.txt');
    const fixture = makeFixture({ planner: async () => proposal('write_text', { path: nested, content: 'verified output' }) });
    try {
      fs.mkdirSync(path.join(fixture.root, 'reports', 'nested'), { recursive: true });
      await fixture.create();
      await fixture.start({ checks: [{ criterion: 0, type: 'text_includes', path: nested, text: 'verified output' }] });
      assert.equal((await fixture.tick()).status, 'QUEUED');
      const final = await fixture.tick();
      assert.equal(final.status, 'COMPLETED');
      assert.equal(final.verification[0].path, 'reports/nested/result.txt');
      assert.match(final.verification[0].sha256, /^[a-f0-9]{64}$/u);
      const state = await fixture.state();
      assert.equal(state.lifecycleState, 'COMPLETED');
      assert.equal(state.finalization.acceptanceResults[0], true);
    } finally { await fixture.dispose(); }
  });

  test('an absolute target outside the project is refused by real scoped host dispatch', async () => {
    const external = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rc-engine-external-')));
    const target = path.join(external, 'protected.txt');
    fs.writeFileSync(target, 'untouched');
    const fixture = makeFixture({ planner: async () => proposal('write_text', { path: target, content: 'verified output' }) });
    try {
      await fixture.create(); await fixture.start();
      const result = await fixture.tick();
      assert.equal(result.status, 'BLOCKED');
      assert.equal(fs.readFileSync(target, 'utf8'), 'untouched');
      assert.notEqual((await fixture.state()).lifecycleState, 'COMPLETED');
      await fixture.tick(); assert.equal(fixture.plans, 1);
    } finally { await fixture.dispose(); fs.rmSync(external, { recursive: true, force: true }); }
  });

  test('an external directory junction cannot redirect a planned write outside the project', async () => {
    const external = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rc-engine-alias-')));
    const target = path.join(external, 'protected.txt');
    fs.writeFileSync(target, 'untouched');
    const fixture = makeFixture({ planner: async () => proposal('write_text', { path: path.join('alias', 'protected.txt'), content: 'verified output' }) });
    try {
      fs.symlinkSync(external, path.join(fixture.root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
      await fixture.create(); await fixture.start();
      const result = await fixture.tick();
      assert.equal(result.status, 'BLOCKED');
      assert.equal(fs.readFileSync(target, 'utf8'), 'untouched');
      assert.notEqual((await fixture.state()).lifecycleState, 'COMPLETED');
    } finally { await fixture.dispose(); fs.rmSync(external, { recursive: true, force: true }); }
  });

  test('an external hardlink alias is refused before a planned write mutates its target', async () => {
    const external = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rc-engine-hardlink-')));
    const target = path.join(external, 'protected.txt');
    fs.writeFileSync(target, 'untouched');
    const fixture = makeFixture({ planner: async () => proposal('write_text', { path: 'result.txt', content: 'verified output' }) });
    try {
      fs.linkSync(target, path.join(fixture.root, 'result.txt'));
      await fixture.create(); await fixture.start();
      const result = await fixture.tick();
      assert.equal(fs.readFileSync(target, 'utf8'), 'untouched', 'The outside file must not be changed through its in-project hardlink');
      assert.equal(result.status, 'BLOCKED');
    } finally { await fixture.dispose(); fs.rmSync(external, { recursive: true, force: true }); }
  });

  for (const [name, write, fullFilesystem] of [
    ['standard write_text', writeText, false], ['full write_text', writeText, true], ['write_file', writeAnyFile, true]
  ]) for (const mode of ['overwrite', 'append']) {
    test(`${name} ${mode} refuses hardlinks before creating backups or audit receipts`, async () => {
      const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rc-write-guard-')));
      const external = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rc-write-guard-external-')));
      const protectedFile = path.join(external, 'protected.txt');
      const backupRoot = path.join(root, 'power-backups');
      const auditLog = path.join(root, 'audit.jsonl');
      const ctx = { roots: [root], auditLog, config: { maxWriteBytes: 524288, powerMode: { enabled: true, fullFilesystem, backupRoot, maxFileBytes: 524288 } } };
      try {
        fs.writeFileSync(protectedFile, 'untouched');
        fs.linkSync(protectedFile, path.join(root, 'alias.txt'));
        await assert.rejects(write(ctx, { path: 'alias.txt', content: 'must not appear', mode }), /FILE_WRITE_HARDLINK/u);
        assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'untouched');
        assert.equal(fs.existsSync(backupRoot), false);
        assert.equal(fs.existsSync(path.join(root, '.remote-commander-backups')), false);
        assert.equal(fs.existsSync(auditLog), false);
      } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(external, { recursive: true, force: true }); }
    });
  }

  test('separate Node processes cannot claim the same project run concurrently', { timeout: 12000 }, async () => {
    const fixture = makeFixture({ planner: async () => { throw new Error('Competing parent must not plan'); } });
    const entered = deferred(), completed = deferred();
    // Attach rejection handlers immediately; a worker startup failure must not
    // leave another concurrently waiting promise as an unhandled rejection.
    entered.promise.catch(() => {}); completed.promise.catch(() => {});
    let child, exited, workerTimer;
    try {
      await fixture.create(); await fixture.start();
      child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--claim-worker', fixture.root], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
      workerTimer = setTimeout(() => child.kill(), 8000);
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      child.on('message', message => {
        if (message?.kind === 'planning') entered.resolve();
        if (message?.kind === 'result') completed.resolve(message.result);
        if (message?.kind === 'error') { const error = new Error(message.message); entered.reject(error); completed.reject(error); }
      });
      exited = new Promise((resolve, reject) => {
        child.once('error', error => { entered.reject(error); completed.reject(error); reject(error); });
        child.once('close', code => {
          clearTimeout(workerTimer);
          if (code !== 0) { const error = new Error(`Claim worker exited ${code}: ${stderr}`); entered.reject(error); completed.reject(error); reject(error); }
          else resolve();
        });
      });
      exited.catch(() => {});
      await entered.promise;
      const competing = await fixture.tick();
      assert.equal(competing.skipped, true);
      assert.equal(fixture.plans, 0);
      assert.equal(fixture.calls, 0);
      child.send({ kind: 'release' });
      const receipt = await completed.promise;
      await exited;
      assert.equal(receipt.status, 'QUEUED');
      assert.equal(receipt.actions, 1);
      assert.equal(fs.readFileSync(path.join(fixture.root, 'result.txt'), 'utf8'), 'verified output');
      assert.equal((await fixture.tick()).status, 'COMPLETED');
      assert.equal((await fixture.api.execute('workflow_operations', { id: 'project' })).operations.length, 1);
    } finally {
      clearTimeout(workerTimer);
      if (child && child.exitCode === null) child.kill();
      await exited?.catch(() => {});
      await fixture.dispose();
    }
  });
  test('bounded worker creates a private receipt before exact coordinator import and independent finalization', async () => {
    const artifactText = 'verified output from isolated worker';
    const fixture = makeFixture({ runner: { worker: { enabled: true, maxArtifactBytes: 4096 } }, planner: async context => {
      if (context.worker?.phase === 'artifact-worker') {
        assert.equal(context.tools, undefined);
        assert.equal(context.commands, undefined);
        assert.equal(context.worker.artifact, 'worker-draft.txt');
        return proposal('write_text', { path: 'worker-draft.txt', content: artifactText });
      }
      if (context.worker?.pending) {
        assert.equal(context.worker.pending.text, artifactText);
        return proposal('write_text', { path: 'result.txt', content: context.worker.pending.text });
      }
      return delegate();
    } });
    try {
      await fixture.create(); await fixture.start({ maxPlannerCalls: 6 });
      const delegated = await fixture.tick();
      assert.equal(delegated.status, 'QUEUED');
      assert.equal(delegated.lastCode, 'PROJECT_WORKER_ARTIFACT_READY');
      assert.equal(delegated.workerActions, 1);
      assert.equal(delegated.actions, 0);
      assert.equal(delegated.plannerCalls, 2);
      assert.equal(delegated.pendingWorker.status, 'READY');
      assert.equal(fs.existsSync(path.join(fixture.root, 'result.txt')), false);
      const imported = await fixture.tick();
      assert.equal(imported.status, 'QUEUED');
      assert.equal(imported.actions, 1);
      assert.equal(imported.pendingWorker, null);
      assert.equal(imported.workerReceipts.length, 1);
      assert.equal(imported.workerReceipts[0].sha256, delegated.pendingWorker.sha256);
      assert.match(imported.workerReceipts[0].inputHash, /^[a-f0-9]{64}$/);
      assert.match(imported.workerReceipts[0].operationId, /^[0-9a-f-]{36}$/);
      assert.equal(fs.readFileSync(path.join(fixture.root, 'result.txt'), 'utf8'), artifactText);
      const final = await fixture.tick();
      assert.equal(final.status, 'COMPLETED');
      assert.equal(final.lastCode, 'PROJECT_ACCEPTANCE_VERIFIED');
      assert.equal(fixture.calls, 1, 'worker workspace creation is not a project-root host dispatch');
      assert.equal(fixture.plans, 3, 'one coordinator delegation, one worker call and one coordinator import');
    } finally { await fixture.dispose(); }
  });

  test('ready worker artifact remains bound to the delegated workflow step', async () => {
    const artifactText = 'verified output delegated first step';
    const fixture = makeFixture({ runner: { worker: { enabled: true, maxArtifactBytes: 4096 } }, planner: async context => {
      if (context.worker?.phase === 'artifact-worker') return proposal('write_text', { path: 'worker-draft.txt', content: artifactText });
      if (context.worker?.pending) return proposal('write_text', { path: 'result.txt', content: context.worker.pending.text });
      return delegate();
    } });
    try {
      await fixture.create('project', [{ id: 'first', title: 'First step' }, { id: 'second', title: 'Second step' }]);
      await fixture.start({ maxPlannerCalls: 6 });
      const delegated = await fixture.tick();
      assert.equal(delegated.pendingWorker.stepId, 'first');
      const state = await fixture.state();
      await fixture.api.execute('workflow_call', { id: 'project', stepId: 'first', expectedRevision: state.revision,
        tool: 'write_text', arguments: { path: 'external-first.txt', content: 'verified output external completion' } });
      const callsBefore = fixture.calls;
      const result = await fixture.tick();
      assert.equal(result.status, 'BLOCKED');
      assert.equal(result.lastCode, 'PROJECT_WORKER_STEP_CHANGED');
      assert.equal(fixture.calls, callsBefore);
      assert.equal(fs.existsSync(path.join(fixture.root, 'result.txt')), false);
      assert.equal((await fixture.state()).steps[1].status, 'pending');
    } finally { await fixture.dispose(); }
  });

  test('worker import accepts an absolute target only when it is contained by the project root', async () => {
    const artifactText = 'verified output absolute contained path';
    const fixture = makeFixture({ runner: { worker: { enabled: true, maxArtifactBytes: 4096 } }, planner: async context => {
      if (context.worker?.phase === 'artifact-worker') return proposal('write_text', { path: 'worker-draft.txt', content: artifactText });
      if (context.worker?.pending) return proposal('write_text', { path: path.join(fixture.root, 'result.txt'), content: context.worker.pending.text });
      return delegate();
    } });
    try {
      await fixture.create(); await fixture.start({ maxPlannerCalls: 6 });
      await fixture.tick();
      const imported = await fixture.tick();
      assert.equal(imported.status, 'QUEUED');
      assert.equal(imported.pendingWorker, null);
      assert.equal(fs.readFileSync(path.join(fixture.root, 'result.txt'), 'utf8'), artifactText);
      assert.equal((await fixture.tick()).status, 'COMPLETED');
    } finally { await fixture.dispose(); }
  });

  test('configured 64KiB worker artifact round-trips even when JSON escaping exceeds the old 64KiB proposal envelope', async () => {
    const prefix = 'verified output';
    const artifactText = prefix + '"'.repeat(65536 - Buffer.byteLength(prefix));
    assert.equal(Buffer.byteLength(artifactText), 65536);
    assert.ok(JSON.stringify({ path: 'result.txt', content: artifactText }).length > 65536);
    const fixture = makeFixture({ runner: { worker: { enabled: true, maxArtifactBytes: 65536 }, maxPlannerCalls: 8 }, planner: async context => {
      if (context.worker?.phase === 'artifact-worker') return proposal('write_text', { path: 'worker-draft.txt', content: artifactText });
      if (context.worker?.pending) return proposal('write_text', { path: 'result.txt', content: context.worker.pending.text });
      return delegate();
    } });
    try {
      await fixture.create(); await fixture.start({ maxPlannerCalls: 8 });
      const delegated = await fixture.tick();
      assert.equal(delegated.pendingWorker.size, 65536);
      const imported = await fixture.tick();
      assert.equal(imported.status, 'QUEUED');
      assert.equal(imported.pendingWorker, null);
      assert.equal(Buffer.byteLength(fs.readFileSync(path.join(fixture.root, 'result.txt'), 'utf8')), 65536);
      assert.equal((await fixture.tick()).status, 'COMPLETED');
    } finally { await fixture.dispose(); }
  });

  test('workflow journal remains bounded above the expanded worker import envelope', async () => {
    const fixture = makeFixture({ planner: async () => { throw new Error('Planner must not run'); } });
    try {
      await fixture.create();
      const state = await fixture.state();
      await assert.rejects(fixture.api.execute('workflow_call', {
        id: 'project', stepId: 'write', expectedRevision: state.revision, tool: 'write_text',
        arguments: { path: 'too-large.txt', content: 'x'.repeat(270000) }
      }), /WORKFLOW_ARGUMENT_LIMIT/);
      assert.equal(fixture.calls, 0);
      assert.equal(fs.existsSync(path.join(fixture.root, 'too-large.txt')), false);
    } finally { await fixture.dispose(); }
  });

  test('worker artifact tampering fails closed before any project effect', async () => {
    const fixture = makeFixture({ runner: { worker: { enabled: true, maxArtifactBytes: 4096 } }, planner: async context => {
      if (context.worker?.phase === 'artifact-worker') return proposal('write_text', { path: 'worker-draft.txt', content: 'verified output original' });
      if (context.worker?.pending) return proposal('write_text', { path: 'result.txt', content: context.worker.pending.text });
      return delegate();
    } });
    try {
      await fixture.create(); await fixture.start({ maxPlannerCalls: 6 });
      const delegated = await fixture.tick();
      const pending = delegated.pendingWorker;
      const workerFile = path.join(fixture.root, 'state', 'project-engine', 'workers', 'run-one', pending.workerId, pending.artifact);
      fs.writeFileSync(workerFile, 'tampered after receipt');
      const result = await fixture.tick();
      assert.equal(result.status, 'BLOCKED');
      assert.equal(result.lastCode, 'PROJECT_WORKER_ARTIFACT_CHANGED');
      assert.equal(fixture.calls, 0);
      assert.equal(fs.existsSync(path.join(fixture.root, 'result.txt')), false);
    } finally { await fixture.dispose(); }
  });

  test('missing worker artifact maps filesystem races to a bounded worker error without project effects', async () => {
    const fixture = makeFixture({ runner: { worker: { enabled: true, maxArtifactBytes: 4096 } }, planner: async context => {
      if (context.worker?.phase === 'artifact-worker') return proposal('write_text', { path: 'worker-draft.txt', content: 'verified output missing race' });
      if (context.worker?.pending) return proposal('write_text', { path: 'result.txt', content: context.worker.pending.text });
      return delegate();
    } });
    try {
      await fixture.create(); await fixture.start({ maxPlannerCalls: 6 });
      const delegated = await fixture.tick();
      const pending = delegated.pendingWorker;
      const workerFile = path.join(fixture.root, 'state', 'project-engine', 'workers', 'run-one', pending.workerId, pending.artifact);
      fs.unlinkSync(workerFile);
      const result = await fixture.tick();
      assert.equal(result.status, 'BLOCKED');
      assert.equal(result.lastCode, 'PROJECT_WORKER_ARTIFACT_CHANGED');
      assert.equal(fixture.calls, 0);
      assert.equal(fs.existsSync(path.join(fixture.root, 'result.txt')), false);
    } finally { await fixture.dispose(); }
  });

  test('delegation is fail-closed when worker execution is not explicitly enabled', async () => {
    const fixture = makeFixture({ planner: async () => delegate() });
    try {
      await fixture.create(); await fixture.start();
      const result = await fixture.tick();
      assert.equal(result.status, 'BLOCKED');
      assert.equal(result.lastCode, 'PROJECT_WORKER_DISABLED');
      assert.equal(fixture.calls, 0);
      assert.equal(result.workerActions, 0);
    } finally { await fixture.dispose(); }
  });

  test('worker provider call consumes durable planner budget before it starts', async () => {
    let workerCalls = 0;
    const fixture = makeFixture({ runner: { worker: { enabled: true } }, planner: async context => {
      if (context.worker?.phase === 'artifact-worker') { workerCalls++; return proposal('write_text', { path: 'worker-draft.txt', content: 'verified output' }); }
      return delegate();
    } });
    try {
      await fixture.create(); await fixture.start({ maxPlannerCalls: 1 });
      const result = await fixture.tick();
      assert.equal(result.status, 'EXHAUSTED');
      assert.equal(result.lastCode, 'PROJECT_WORKER_BUDGET_EXHAUSTED');
      assert.equal(result.plannerCalls, 1);
      assert.equal(workerCalls, 0);
      assert.equal(fixture.calls, 0);
    } finally { await fixture.dispose(); }
  });

  test('cancel during worker planning aborts the worker and performs no project or workspace artifact effect', { timeout: 6000 }, async () => {
    const entered = deferred(); let aborted = false;
    const fixture = makeFixture({ runner: { worker: { enabled: true } }, planner: async (context, { signal }) => {
      if (context.worker?.phase !== 'artifact-worker') return delegate();
      entered.resolve();
      return new Promise((resolve, reject) => {
        const stop = () => { aborted = true; reject(Object.assign(new Error('worker aborted'), { code: 'PLANNER_ABORTED' })); };
        if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
      });
    } });
    let pending;
    try {
      await fixture.create(); await fixture.start({ maxPlannerCalls: 6 });
      pending = fixture.tick(); await entered.promise;
      const state = await fixture.state();
      await fixture.api.execute('workflow_control', { id: 'project', expectedRevision: state.revision, action: 'cancel', reason: 'Cancel delegated worker' });
      const result = await pending;
      assert.equal(aborted, true);
      assert.equal(result.status, 'CANCELLED');
      assert.equal(result.lastCode, 'PROJECT_CANCELLED');
      assert.equal(fixture.calls, 0);
      assert.equal(fs.existsSync(path.join(fixture.root, 'result.txt')), false);
      const pendingWorker = result.pendingWorker;
      assert.equal(pendingWorker.status, 'RESERVED');
      const workerDir = path.join(fixture.root, 'state', 'project-engine', 'workers', 'run-one', pendingWorker.workerId);
      assert.equal(fs.existsSync(workerDir), false);
    } finally { await pending?.catch(() => {}); await fixture.dispose(); }
  });


  test('worker artifact hardlink alias fails closed before coordinator import', async () => {
    const fixture = makeFixture({ runner: { worker: { enabled: true, maxArtifactBytes: 4096 } }, planner: async context => {
      if (context.worker?.phase === 'artifact-worker') return proposal('write_text', { path: 'worker-draft.txt', content: 'verified output hardlink guard' });
      if (context.worker?.pending) return proposal('write_text', { path: 'result.txt', content: context.worker.pending.text });
      return delegate();
    } });
    try {
      await fixture.create(); await fixture.start({ maxPlannerCalls: 6 });
      const delegated = await fixture.tick();
      const pending = delegated.pendingWorker;
      const workerFile = path.join(fixture.root, 'state', 'project-engine', 'workers', 'run-one', pending.workerId, pending.artifact);
      fs.linkSync(workerFile, workerFile + '.alias');
      const result = await fixture.tick();
      assert.equal(result.status, 'BLOCKED');
      assert.equal(result.lastCode, 'PROJECT_WORKER_ARTIFACT_CHANGED');
      assert.equal(fixture.calls, 0);
      assert.equal(fs.existsSync(path.join(fixture.root, 'result.txt')), false);
    } finally { await fixture.dispose(); }
  });

  async function crashAfterWorkerImport({ tamperAfterCrash = false, mismatchedJournal = false } = {}) {
    const artifactText = 'verified output crash recovery';
    const fixture = makeFixture({ runner: { worker: { enabled: true, maxArtifactBytes: 4096 } }, planner: async context => {
      if (context.worker?.phase === 'artifact-worker') return proposal('write_text', { path: 'worker-draft.txt', content: artifactText });
      if (context.worker?.pending) return proposal('write_text', { path: 'result.txt', content: context.worker.pending.text });
      return delegate();
    } });
    await fixture.create(); await fixture.start({ maxPlannerCalls: 6 });
    const delegated = await fixture.tick();
    assert.equal(delegated.pendingWorker.status, 'READY');
    await fixture.api.close();

    const urls = Object.fromEntries(['workflow-tools','project-engine','schema-validator','tools-v0.3'].map(name => [name, new URL('../src/' + name + '.mjs', import.meta.url).href]));
    const childConfig = {
      allowedRoots: [fixture.root],
      maxWriteBytes: 524288,
      maxReadBytes: 524288,
      auditLog: path.join(fixture.root, 'audit.jsonl'),
      durableWorkflows: {
        enabled: true,
        directory: path.join(fixture.root, 'state'),
        executionTools: Object.keys(definitions),
        scheduler: { enabled: false, intervalMs: 1000, oneWriterPerRoot: true },
        runner: { enabled: false }
      }
    };
    const childPolicy = {
      enabled: true,
      allowedTools: Object.keys(definitions),
      maxActions: 10,
      maxDurationMs: 30000,
      worker: { enabled: true, maxArtifactBytes: 4096 }
    };
    const childScript = [
      "import { createWorkflowTools } from " + JSON.stringify(urls['workflow-tools']) + ";",
      "import { createProjectEngine } from " + JSON.stringify(urls['project-engine']) + ";",
      "import { validateJsonSchema } from " + JSON.stringify(urls['schema-validator']) + ";",
      "import { writeText, readText, listDirectory } from " + JSON.stringify(urls['tools-v0.3']) + ";",
      "import path from 'node:path';",
      "const config=JSON.parse(process.argv[1]),defs=JSON.parse(process.argv[2]),policy=JSON.parse(process.argv[3]),artifactText=process.argv[4],mismatchedJournal=process.argv[5]==='mismatch'; if(mismatchedJournal)defs.write_text.inputSchema.properties.mode={type:'string',enum:['overwrite','append']};",
      "const root=config.allowedRoots[0],ctx={roots:[root],auditLog:config.auditLog,config:{...config,allowedRoots:[root],powerMode:{fullFilesystem:false}}};",
      "const dispatch=async(name,args)=>name==='write_text'?writeText(ctx,args):name==='read_text'?readText(ctx,args):listDirectory(ctx,args);",
      "const core=createWorkflowTools({config,roots:[root],device:'integration-fixture',configSha256:'7'.repeat(64),lookup:n=>defs[n],validateSchema:validateJsonSchema,dispatch});",
      "const planner={describe:()=>({kind:'integration-fixture'}),plan:async context=>{if(!context.worker?.pending)throw new Error('WORKER_PENDING_ARTIFACT_MISSING');return {action:'call',tool:'write_text',argumentsJson:JSON.stringify({path:'result.txt',content:artifactText}),summary:'Import exact worker artifact'};}};",
      "const engine=createProjectEngine({directory:path.join(config.durableWorkflows.directory,'project-engine'),planner,workerPlanner:planner,policy,lookup:n=>defs[n],execute:async(name,args)=>{const actual=name==='workflow_call'&&mismatchedJournal?{...args,arguments:{...args.arguments,mode:'overwrite'}}:args;const result=await core.execute(name,actual);if(name==='workflow_call')process.exit(73);return result;}});",
      "await engine.tick('run-one');"
    ].join('\n');
    const child = spawn(process.execPath, ['--input-type=module','-e',childScript,JSON.stringify(childConfig),JSON.stringify(definitions),JSON.stringify(childPolicy),artifactText,mismatchedJournal?'mismatch':'exact'],
      { stdio: ['ignore','pipe','pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const exitCode = await new Promise((resolve,reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(exitCode, 73, stderr);
    assert.equal(fs.readFileSync(path.join(fixture.root,'result.txt'),'utf8'), artifactText);

    if(tamperAfterCrash)fs.writeFileSync(path.join(fixture.root,'result.txt'),'tampered after committed import');

    const resumeConfig={...childConfig,durableWorkflows:{...childConfig.durableWorkflows,runner:{
      ...childPolicy,autoTick:false
    }}};
    const dispatches=[];
    const resumed=createWorkflowTools({
      config:resumeConfig,roots:[fixture.root],device:'integration-fixture',configSha256:'7'.repeat(64),
      lookup:name=>definitions[name],validateSchema:validateJsonSchema,
      planner:{
        describe:()=>({kind:'integration-fixture'}),
        plan:async()=>{throw new Error('Recovered import must not invoke planner');}
      },
      dispatch:async(name,args)=>{
        dispatches.push({name,args});
        const ctx={roots:[fixture.root],auditLog:resumeConfig.auditLog,config:{...resumeConfig,allowedRoots:[fixture.root],powerMode:{fullFilesystem:false}}};
        return name==='write_text'?writeText(ctx,args):name==='read_text'?readText(ctx,args):listDirectory(ctx,args);
      }
    });
    return {fixture,resumed,dispatches};
  }

  // Windows CI process spawning and SQLite file admission are nondeterministic under host contention.
  // Preserve all crash/idempotency assertions; adjust ONLY the test harness watchdog.
  const CRASH_RECOVERY_TEST_TIMEOUT_MS = process.platform === 'win32' ? 30000 : 10000;
  test('crash after journaled worker import is adopted exactly once without replay', { timeout: CRASH_RECOVERY_TEST_TIMEOUT_MS }, async () => {
    const {fixture,resumed,dispatches}=await crashAfterWorkerImport();
    try {
      const result=await resumed.execute('workflow_run_tick',{runId:'run-one'});
      assert.equal(result.status,'COMPLETED');
      assert.equal(result.lastCode,'PROJECT_ACCEPTANCE_VERIFIED');
      assert.equal(result.pendingWorker,null);
      assert.equal(result.workerReceipts.length,1);
      assert.equal(result.workerReceipts[0].recovered,true);
      assert.equal(dispatches.length,0,'recovery must not replay the project write');
      const operations=await resumed.execute('workflow_operations',{id:'project'});
      assert.equal(operations.operations.length,1);
    } finally { await resumed.close(); fs.rmSync(fixture.root,{recursive:true,force:true}); }
  });

  test('tampered project import after crash blocks recovery without replay', { timeout: CRASH_RECOVERY_TEST_TIMEOUT_MS }, async () => {
    const {fixture,resumed,dispatches}=await crashAfterWorkerImport({tamperAfterCrash:true});
    try {
      const result=await resumed.execute('workflow_run_tick',{runId:'run-one'});
      assert.equal(result.status,'BLOCKED');
      assert.equal(result.lastCode,'PROJECT_WORKER_IMPORT_UNCONFIRMED');
      assert.equal(dispatches.length,0);
      const operations=await resumed.execute('workflow_operations',{id:'project'});
      assert.equal(operations.operations.length,1);
    } finally { await resumed.close(); fs.rmSync(fixture.root,{recursive:true,force:true}); }
  });

  test('crash recovery refuses same bytes produced by a different journaled write call', { timeout: CRASH_RECOVERY_TEST_TIMEOUT_MS }, async () => {
    const {fixture,resumed,dispatches}=await crashAfterWorkerImport({mismatchedJournal:true});
    try {
      assert.equal(fs.readFileSync(path.join(fixture.root,'result.txt'),'utf8'),'verified output crash recovery');
      const result=await resumed.execute('workflow_run_tick',{runId:'run-one'});
      assert.equal(result.status,'BLOCKED');
      assert.equal(result.lastCode,'PROJECT_WORKER_IMPORT_UNCONFIRMED');
      assert.equal(dispatches.length,0);
      const operations=await resumed.execute('workflow_operations',{id:'project'});
      assert.equal(operations.operations.length,1);
      assert.equal(operations.operations[0].tool,'write_text');
    } finally { await resumed.close(); fs.rmSync(fixture.root,{recursive:true,force:true}); }
  });

  test('worker provider failure is never blindly replayed after a durable reservation', async () => {
    let workerCalls = 0;
    const fixture = makeFixture({ runner: { worker: { enabled: true } }, planner: async context => {
      if (context.worker?.phase === 'artifact-worker') {
        workerCalls++;
        throw Object.assign(new Error('private provider failure'), { code: 'PLANNER_PROVIDER_FAILED' });
      }
      return delegate();
    } });
    try {
      await fixture.create(); await fixture.start({ maxPlannerCalls: 6 });
      const first = await fixture.tick();
      assert.equal(first.status, 'BLOCKED');
      assert.equal(first.pendingWorker.status, 'RESERVED');
      assert.equal(workerCalls, 1);
      const second = await fixture.tick();
      assert.equal(second.skipped, true);
      assert.equal(workerCalls, 1);
      assert.equal(fixture.calls, 0);
    } finally { await fixture.dispose(); }
  });

}
