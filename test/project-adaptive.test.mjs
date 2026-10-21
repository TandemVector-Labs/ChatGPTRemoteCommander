import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createWorkflowTools } from '../src/workflow-tools.mjs';
import { WorkflowStore } from '../src/workflow-store.mjs';
import { validateJsonSchema } from '../src/schema-validator.mjs';
import { readText, writeText } from '../src/tools-v0.3.mjs';

const definitions = {
  read_text: { name: 'read_text', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  write_text: { name: 'write_text', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } }
};
const checks = [{ criterion: 0, type: 'text_includes', path: 'result.txt', text: 'verified output' }];
// Crash recovery asserts journal/budget invariants, not process-startup latency.
// Concurrent Windows CI can delay startup and synchronous SQLite durability.
// Keep the child watchdog inside the scenario timeout, and the fixture's project
// deadline outside both so host contention cannot masquerade as a runtime expiry.
const CRASH_CHILD_TIMEOUT_MS = 30000;
const CRASH_TEST_TIMEOUT_MS = 90000;
const CRASH_RUN_DURATION_MS = 120000;
const call = (tool, args) => ({ action: 'call', tool, argumentsJson: JSON.stringify(args), summary: 'Perform one approved project action' });
const extend = (steps = [{ id: 'needed', title: 'Read missing source evidence' }], extras = {}) => ({ action: 'extend', tool: '', argumentsJson: JSON.stringify({ steps, reason: 'The pending action requires additional source evidence', ...extras }), summary: 'Insert a required prerequisite' });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function defaultPlanner(context) {
  if (context.currentStep.id === 'needed') return call('read_text', { path: 'source.txt' });
  const source = context.observations.find(item => item.stepId === 'needed');
  return source ? call('write_text', { path: 'result.txt', content: source.result.text }) : extend();
}
function fixture({ root, planner = defaultPlanner, runner = {} } = {}) {
  root ??= fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rc-adaptive-')));
  const config = {
    allowedRoots: [root], maxReadBytes: 524288, maxWriteBytes: 524288, auditLog: path.join(root, 'audit.jsonl'),
    durableWorkflows: {
      enabled: true, directory: path.join(root, 'state'), executionTools: Object.keys(definitions),
      runner: { enabled: true, autoTick: false, allowedTools: Object.keys(definitions), maxActions: 10, maxDurationMs: 120000, maxPlannerCalls: 30, adaptive: { enabled: true, maxExtensions: 4 }, ...runner }
    }
  };
  let plans = 0, effects = 0, reads = 0, api;
  const dispatchErrors = [];
  const options = {
    config, roots: [root], device: 'adaptive-fixture', configSha256: '4'.repeat(64), lookup: name => definitions[name], validateSchema: validateJsonSchema,
    planner: { plan: async (...args) => { plans++; return planner(...args); }, describe: () => ({ kind: 'adaptive-fixture' }) },
    dispatch: async (name, args, workflow) => {
      const ctx = { roots: [workflow.root], config: { ...config, allowedRoots: [workflow.root], powerMode: { fullFilesystem: false } }, auditLog: config.auditLog };
      if (name === 'read_text') { reads++; return readText(ctx, args); }
      effects++;
      try { return await writeText(ctx, args); }
      catch (error) { dispatchErrors.push(`${error.code ?? ''} ${error.message}`); throw error; }
    }
  };
  api = createWorkflowTools(options);
  return {
    root, dispatchErrors, get api() { return api; }, get plans() { return plans; }, get effects() { return effects; }, get reads() { return reads; },
    async create(steps = [{ id: 'write', title: 'Write result from verified source' }]) {
      fs.writeFileSync(path.join(root, 'source.txt'), 'verified output');
      return api.execute('workflow_create', { id: 'project', root, goal: 'Produce the requested evidence-backed result', acceptance: ['Result includes verified source output'], steps });
    },
    async start(extra = {}) { const state = (await api.execute('workflow_get', { id: 'project' })).state; return api.execute('workflow_run_start', { id: 'project', runId: 'run-one', expectedRevision: state.revision, checks, ...extra }); },
    tick: () => api.execute('workflow_run_tick', { runId: 'run-one' }),
    state: async () => (await api.execute('workflow_get', { id: 'project' })).state,
    status: () => api.execute('workflow_run_status', { runId: 'run-one' }),
    persisted() {
      const db = new DatabaseSync(path.join(root, 'state', 'project-engine', 'project-runs.sqlite'), { readOnly: true });
      try { return JSON.parse(db.prepare('SELECT state FROM project_runs WHERE id=?').get('run-one').state); } finally { db.close(); }
    },
    async close() { if (api) { await api.close(); api = null; } },
    async reopen() { if (api) await api.close(); api = createWorkflowTools(options); },
    async dispose() { if (api) await api.close(); fs.rmSync(root, { recursive: true, force: true }); }
  };
}
const crashFixture = ({ root, planner } = {}) => fixture({ root, planner, runner: { maxDurationMs: CRASH_RUN_DURATION_MS } });
async function crashAfterExtension(root, mode = '--crash-extension', t) {
  const signal = t?.signal;
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), mode, root], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    let stderr = '', phase = 'starting', readyAfterMs = null, terminationReason = null;
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-32768); });
    child.on('message', message => {
      if (message?.phase === 'ready') { phase = 'executing'; readyAfterMs = Math.round(performance.now() - started); }
    });
    const stop = reason => { terminationReason ??= reason; child.kill('SIGKILL'); };
    const aborted = () => stop('test-aborted');
    const timer = setTimeout(() => stop('child-timeout'), CRASH_CHILD_TIMEOUT_MS);
    signal?.addEventListener('abort', aborted, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', (code, exitSignal) => {
      cleanup();
      const outcome = { code, exitSignal, phase, readyAfterMs, elapsedMs: Math.round(performance.now() - started), terminationReason, stderr };
      if (!signal?.aborted) t?.diagnostic(`Crash worker ${mode}: ${JSON.stringify(outcome)}`);
      resolve(outcome);
    });
    // The test may abort between the pre-spawn check and listener registration.
    if (signal?.aborted) aborted();
  });
}
async function prepareCommittedCrash(f, t) {
  await f.create();
  const enrolled = await f.start({ maxPlannerCalls: 5 });
  await f.close();
  const crashed = await crashAfterExtension(f.root, '--crash-extension', t);
  assert.equal(crashed.code, 73, JSON.stringify(crashed));
  await f.reopen();
  assert.equal((await f.state()).planExtensions.length, 1);
  const pending = await f.status();
  assert.equal(pending.plannerCalls, 1);
  assert.equal(pending.extensions, 1);
  assert.ok(pending.pendingExtension);
  assert.equal(pending.deadline, enrolled.deadline);
  return pending;
}

if (['--crash-extension', '--crash-before-extension', '--crash-extension-extra'].includes(process.argv[2])) {
  const original = WorkflowStore.prototype.extendPlan;
  WorkflowStore.prototype.extendPlan = async function (...args) {
    if (process.argv[2] === '--crash-before-extension') process.exit(73);
    const committed = await original.apply(this, args);
    if (process.argv[2] === '--crash-extension-extra') {
      // A second, valid journal edit was not the engine's reserved mutation.
      await original.call(this, { ...args[0], expectedRevision: committed.state.revision, operationId: randomUUID(), steps: [{ id: 'unrelated', title: 'A separately inserted prerequisite' }], reason: 'Independent topology change' });
    }
    process.exit(73); // Exact durable-store commit / engine acknowledgement boundary.
  };
  const f = crashFixture({ root: process.argv[3], planner: async () => extend() });
  // Acknowledged readiness distinguishes slow process/import/store startup from
  // a stalled crash boundary, without moving the actual exit-after-commit point.
  if (process.send) await new Promise((resolve, reject) => process.send({ phase: 'ready' }, error => error ? reject(error) : resolve()));
  await f.tick();
  await f.close();
  process.exit(74);
} else {
  // Strict team-reservation timeout is a real 6s acceptance gate: run
  // before crash-worker fixtures accumulate I/O; assertions unchanged.
  const team = { workers: [{ id: 'reader', role: 'Inspect the evidence' }, { id: 'reviewer', role: 'Review acceptance and safety' }], maxParallel: 2 };

  test('team reserves all calls before workers and executes only the coordinator proposal', { timeout: 6000 }, async () => {
    const entered = deferred(), release = deferred();
    let active = 0, maximum = 0, advice;
    const reservations = [];
    const f = fixture({ runner: { team }, planner: async context => {
      if (context.collaboration.phase === 'worker') {
        reservations.push(f.persisted().plannerCalls);
        active++; maximum = Math.max(maximum, active);
        await new Promise(resolve => setTimeout(resolve, 20));
        active--;
        return call('write_text', { path: `${context.collaboration.id}.txt`, content: 'Worker advice must not execute' });
      }
      advice = context.collaboration;
      entered.resolve(); await release.promise;
      return call('write_text', { path: 'result.txt', content: 'verified output' });
    } });
    let pending;
    try {
      await f.create(); await f.start({ maxPlannerCalls: 3 });
      pending = f.tick(); await entered.promise;
      assert.equal(f.plans, 3);
      assert.deepEqual(reservations, [3, 3]);
      assert.equal((await f.status()).plannerCalls, 3);
      assert.equal(f.effects, 0);
      assert.equal(fs.existsSync(path.join(f.root, 'result.txt')), false);
      assert.equal(maximum, 2);
      assert.equal(advice.adviceTrust, 'untrusted');
      assert.equal(advice.workerProposals.length, 2);
      release.resolve();
      assert.equal((await pending).status, 'QUEUED', f.dispatchErrors.join('\n'));
      assert.equal(f.effects, 1);
      assert.equal(fs.existsSync(path.join(f.root, 'reader.txt')), false);
      assert.equal(fs.existsSync(path.join(f.root, 'reviewer.txt')), false);
      const final = await f.tick();
      assert.equal(final.status, 'COMPLETED', JSON.stringify({ code: final.lastCode, verification: final.verification }));
      assert.equal(final.plannerCalls, 3);
      assert.equal(f.plans, 3);
    } finally { release.resolve(); await pending; await f.dispose(); }
  });

  test('inspect, extend, read prerequisite, execute and verify preserves immutable acceptance', async () => {
    const f = fixture({ planner: async context => {
      if (context.currentStep.id === 'inspect') return call('read_text', { path: 'requirements.txt' });
      if (context.currentStep.id === 'detail') {
        const requirement = context.observations.find(item => item.stepId === 'inspect');
        return call('read_text', { path: requirement.result.text });
      }
      const detail = context.observations.find(item => item.stepId === 'detail');
      return detail ? call('write_text', { path: 'result.txt', content: detail.result.text })
        : extend([{ id: 'detail', title: 'Read the source selected by inspected requirements' }]);
    } });
    try {
      await f.create([{ id: 'inspect', title: 'Inspect project requirements' }, { id: 'write', title: 'Write verified result' }]);
      fs.writeFileSync(path.join(f.root, 'requirements.txt'), 'source.txt');
      const original = await f.state();
      await f.start();
      assert.equal((await f.tick()).lastCode, 'PROJECT_STEP_RECORDED');
      const extension = await f.tick();
      assert.equal(extension.lastCode, 'PROJECT_PLAN_EXTENDED');
      assert.equal(extension.extensions, 1);
      assert.equal(f.effects, 0);
      const changed = await f.state();
      assert.deepEqual(changed.steps.map(step => step.id), ['inspect', 'detail', 'write']);
      assert.equal(changed.steps[0].status, 'verified');
      assert.deepEqual(changed.acceptance, original.acceptance);
      assert.equal(changed.goal, original.goal);
      assert.equal(changed.root, original.root);
      assert.deepEqual(f.persisted().checks, checks);
      assert.equal((await f.tick()).lastCode, 'PROJECT_STEP_RECORDED');
      assert.equal((await f.tick()).lastCode, 'PROJECT_STEP_RECORDED', f.dispatchErrors.join('\n'));
      const final = await f.tick();
      assert.equal(final.status, 'COMPLETED', JSON.stringify({ code: final.lastCode, verification: final.verification }));
      assert.equal(final.plannerCalls, 4);
      assert.equal(final.attempts, 4);
      assert.equal(final.actions, 3);
      assert.equal(f.effects, 1);
      assert.equal(fs.readFileSync(path.join(f.root, 'result.txt'), 'utf8'), 'verified output');
      assert.equal((await f.state()).finalization.acceptanceResults[0], true);
      assert.equal((await f.api.execute('workflow_operations', { id: 'project' })).operations.length, 3);
      assert.equal(f.api.definitions.length, 22);
      assert.equal(f.api.definitions.some(tool => tool.name === 'workflow_needs_chat'), true);
      assert.equal(f.api.definitions.some(tool => tool.name === 'workflow_plan_extend'), false);
    } finally { await f.dispose(); }
  });

  test('duplicate extension receipt is idempotent and conflicting reuse changes nothing', async t => {
    const originalExtend = WorkflowStore.prototype.extendPlan;
    let captured;
    t.mock.method(WorkflowStore.prototype, 'extendPlan', function (args) {
      const first = originalExtend.call(this, args);
      const second = originalExtend.call(this, args);
      let conflict;
      try { originalExtend.call(this, { ...args, reason: 'Conflicting replacement' }); } catch (error) { conflict = error; }
      captured = { first, second, conflict, after: this.get(args.id).state };
      return first;
    });
    const f = fixture();
    try {
      await f.create(); await f.start();
      assert.equal((await f.tick()).lastCode, 'PROJECT_PLAN_EXTENDED');
      assert.ok(captured);
      assert.equal(captured.second.state.revision, captured.first.state.revision);
      assert.equal(captured.after.planExtensions.length, 1);
      assert.deepEqual(captured.after.steps, captured.first.state.steps);
      assert.match(captured.conflict?.message ?? '', /CONFLICT|MISMATCH/u);
      assert.equal(captured.after.revision, captured.first.state.revision);
    } finally { await f.dispose(); }
  });

  for (const action of ['pause', 'revise']) test(`${action} while the planner is pending fences the proposed extension`, async () => {
    const entered = deferred(), release = deferred();
    const f = fixture({ planner: async () => { entered.resolve(); return release.promise; } });
    let pending;
    try {
      await f.create(); await f.start(); pending = f.tick(); await entered.promise;
      const state = await f.state();
      if (action === 'pause') await f.api.execute('workflow_control', { id: 'project', expectedRevision: state.revision, action: 'pause', reason: 'User paused' });
      else await f.api.execute('workflow_revise', { id: 'project', expectedRevision: state.revision, acceptance: ['New user acceptance criterion'], reason: 'User changed the requirement' });
      release.resolve(extend());
      const result = await pending;
      assert.equal(result.lastCode, action === 'pause' ? 'PROJECT_PAUSED' : 'PROJECT_SCOPE_CHANGED');
      assert.equal(result.plannerCalls, 1);
      assert.equal(result.extensions, 0);
      assert.deepEqual((await f.state()).steps.map(step => step.id), ['write']);
      assert.equal(f.effects, 0);
      assert.deepEqual(f.persisted().checks, checks);
    } finally { release.resolve(extend()); await pending; await f.dispose(); }
  });

  for (const extra of [{ acceptance: ['Easy substitute'] }, { checks: [] }, { targetStepId: 'other' }, { root: 'elsewhere' }]) {
    test(`extension payload cannot override ${Object.keys(extra)[0]}`, async () => {
      const f = fixture({ planner: async () => extend(undefined, extra) });
      try {
        await f.create(); const original = await f.state(); await f.start();
        const result = await f.tick();
        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.lastCode, 'PROJECT_EXTENSION_INVALID');
        assert.equal(result.extensions, 0);
        const after = await f.state();
        assert.deepEqual(after.steps, original.steps);
        assert.deepEqual(after.acceptance, original.acceptance);
        assert.equal(after.root, original.root);
        assert.deepEqual(f.persisted().checks, checks);
      } finally { await f.dispose(); }
    });
  }

  test('disabled adaptive policy refuses planner extensions without changing topology', async () => {
    const f = fixture({ runner: { adaptive: { enabled: false } }, planner: async () => extend() });
    try {
      await f.create(); await f.start(); const result = await f.tick();
      assert.equal(result.lastCode, 'PROJECT_ADAPTIVE_DISABLED');
      assert.equal(result.extensions, 0);
      assert.deepEqual((await f.state()).steps.map(step => step.id), ['write']);
    } finally { await f.dispose(); }
  });

  test('extension budget remains spent after restart and prevents another topology edit', async () => {
    let index = 0;
    const f = fixture({ runner: { adaptive: { enabled: true, maxExtensions: 1 } }, planner: async () => extend([{ id: `extra-${++index}`, title: 'Additional prerequisite' }]) });
    try {
      await f.create(); await f.start(); assert.equal((await f.tick()).extensions, 1);
      const prior = await f.status(); await f.reopen();
      const final = await f.tick();
      assert.equal(final.status, 'EXHAUSTED');
      assert.equal(final.lastCode, 'PROJECT_EXTENSION_BUDGET_EXHAUSTED');
      assert.equal(final.extensions, 1);
      assert.equal(final.plannerCalls, 2);
      assert.equal(final.deadline, prior.deadline);
      assert.deepEqual((await f.state()).steps.map(step => step.id), ['extra-1', 'write']);
    } finally { await f.dispose(); }
  });

  test('lost extension acknowledgement adopts its exact receipt instead of retrying the plan', async t => {
    const original = WorkflowStore.prototype.extendPlan;
    t.mock.method(WorkflowStore.prototype, 'extendPlan', async function (...args) { await original.apply(this, args); throw new Error('Lost extension acknowledgement'); });
    const f = fixture();
    try {
      await f.create(); await f.start(); const result = await f.tick();
      assert.equal(result.status, 'QUEUED');
      assert.equal(result.lastCode, 'PROJECT_PLAN_EXTENSION_RECOVERED');
      assert.equal(result.pendingExtension, null);
      assert.equal(result.extensions, 1);
      assert.equal(result.plannerCalls, 1);
      assert.equal(f.plans, 1);
      assert.equal((await f.state()).planExtensions.length, 1);
      assert.equal(f.effects, 0);
    } finally { await f.dispose(); }
  });

  test('process crash after store commit recovers exactly once without replenishing budgets', { timeout: CRASH_TEST_TIMEOUT_MS }, async t => {
    const f = crashFixture();
    try {
      const pending = await prepareCommittedCrash(f, t);
      const recovered = await f.tick();
      assert.equal(recovered.lastCode, 'PROJECT_PLAN_EXTENSION_RECOVERED');
      assert.equal(recovered.pendingExtension, null);
      assert.equal(recovered.plannerCalls, pending.plannerCalls);
      assert.equal(recovered.attempts, pending.attempts);
      assert.equal(recovered.extensions, pending.extensions);
      assert.equal(recovered.maxPlannerCalls, 5);
      assert.equal(recovered.deadline, pending.deadline);
      assert.equal(f.plans, 0);
      assert.equal(f.effects, 0);
      assert.deepEqual((await f.state()).steps.map(step => step.id), ['needed', 'write']);
      assert.equal((await f.tick()).lastCode, 'PROJECT_STEP_RECORDED');
      assert.equal((await f.tick()).lastCode, 'PROJECT_STEP_RECORDED', f.dispatchErrors.join('\n'));
      const final = await f.tick();
      assert.equal(final.status, 'COMPLETED', JSON.stringify({ code: final.lastCode, verification: final.verification }));
      assert.equal(final.plannerCalls, 3);
      assert.equal(final.extensions, 1);
      assert.equal(f.effects, 1);
      assert.equal((await f.state()).planExtensions.length, 1);
    } finally { await f.dispose(); }
  });

  test('pause after committed extension remains authoritative during crash recovery', { timeout: CRASH_TEST_TIMEOUT_MS }, async t => {
    const f = crashFixture();
    try {
      await prepareCommittedCrash(f, t);
      const state = await f.state();
      await f.api.execute('workflow_control', { id: 'project', expectedRevision: state.revision, action: 'pause', reason: 'User paused before recovery' });
      const result = await f.tick();
      assert.equal(result.status, 'PAUSED');
      assert.equal(result.lastCode, 'PROJECT_PAUSED');
      assert.equal(result.plannerCalls, 1);
      assert.equal(result.extensions, 1);
      assert.equal(f.plans, 0);
      assert.equal(f.effects, 0);
      assert.equal((await f.state()).control.intent, 'PAUSED');
    } finally { await f.dispose(); }
  });

  test('crash before extension commit fails closed without replaying a reserved mutation', { timeout: CRASH_TEST_TIMEOUT_MS }, async t => {
    const f = crashFixture();
    try {
      await f.create(); await f.start(); await f.close();
      const crash = await crashAfterExtension(f.root, '--crash-before-extension', t);
      assert.equal(crash.code, 73, JSON.stringify(crash));
      await f.reopen();
      assert.equal((await f.state()).planExtensions.length, 0);
      const result = await f.tick();
      assert.equal(result.status, 'BLOCKED');
      assert.equal(result.lastCode, 'PROJECT_EXTENSION_UNCONFIRMED');
      assert.equal(result.plannerCalls, 1);
      assert.equal(result.extensions, 1);
      assert.equal(f.plans, 0);
      assert.equal(f.effects, 0);
      assert.deepEqual((await f.state()).steps.map(step => step.id), ['write']);
    } finally { await f.dispose(); }
  });

  test('recovery refuses a valid journal receipt when a later topology edit changed its result', { timeout: CRASH_TEST_TIMEOUT_MS }, async t => {
    const f = crashFixture();
    try {
      await f.create(); await f.start(); await f.close();
      const crash = await crashAfterExtension(f.root, '--crash-extension-extra', t);
      assert.equal(crash.code, 73, JSON.stringify(crash));
      await f.reopen();
      assert.equal((await f.state()).planExtensions.length, 2);
      const result = await f.tick();
      assert.equal(result.status, 'BLOCKED');
      assert.equal(result.lastCode, 'PROJECT_EXTENSION_RECEIPT_MISMATCH');
      assert.equal(result.plannerCalls, 1);
      assert.equal(f.plans, 0);
      assert.equal(f.effects, 0);
    } finally { await f.dispose(); }
  });

  test('user criteria changed after an extension crash prevents adoption into the old run', { timeout: CRASH_TEST_TIMEOUT_MS }, async t => {
    const f = crashFixture();
    try {
      await prepareCommittedCrash(f, t);
      const state = await f.state();
      await f.api.execute('workflow_revise', { id: 'project', expectedRevision: state.revision, acceptance: ['Different user criterion'], reason: 'Requirement changed after interruption' });
      const result = await f.tick();
      assert.equal(result.status, 'BLOCKED');
      assert.equal(result.lastCode, 'PROJECT_SCOPE_CHANGED');
      assert.equal(result.plannerCalls, 1);
      assert.equal(f.plans, 0);
      assert.equal(f.effects, 0);
      assert.deepEqual(f.persisted().checks, checks);
    } finally { await f.dispose(); }
  });

  test('insufficient team call budget prevents every worker and coordinator call', async () => {
    const f = fixture({ runner: { team }, planner: async () => { throw new Error('No provider call is authorized'); } });
    try {
      await f.create(); await f.start({ maxPlannerCalls: 2 });
      const result = await f.tick();
      assert.equal(result.status, 'EXHAUSTED');
      assert.equal(result.lastCode, 'PROJECT_PLANNER_BUDGET_EXHAUSTED');
      assert.equal(result.plannerCalls, 0);
      assert.equal(result.attempts, 0);
      assert.equal(f.plans, 0);
      assert.equal(f.effects, 0);
    } finally { await f.dispose(); }
  });

  test('team call reservation survives restart and duplicate enrollment without refill', async () => {
    const f = fixture({ runner: { team }, planner: async () => call('read_text', { path: 'source.txt' }) });
    try {
      await f.create([{ id: 'inspect', title: 'Inspect source' }, { id: 'write', title: 'Write the result' }]);
      const enrolled = await f.start({ maxPlannerCalls: 3 });
      assert.equal((await f.tick()).plannerCalls, 3);
      await f.reopen();
      const duplicate = await f.start({ maxPlannerCalls: 30 });
      assert.equal(duplicate.maxPlannerCalls, 3);
      assert.equal(duplicate.plannerCalls, 3);
      assert.equal(duplicate.deadline, enrolled.deadline);
      const result = await f.tick();
      assert.equal(result.lastCode, 'PROJECT_PLANNER_BUDGET_EXHAUSTED');
      assert.equal(f.plans, 3);
      assert.equal(f.effects, 0);
    } finally { await f.dispose(); }
  });

  test('coordinator failure consumes the complete reservation and performs zero effects', async () => {
    const f = fixture({ runner: { team }, planner: async context => {
      if (context.collaboration.phase === 'worker') return call('write_text', { path: 'result.txt', content: 'verified output' });
      throw Object.assign(new Error('Coordinator failed'), { code: 'PLANNER_COORDINATOR_FAILED' });
    } });
    try {
      await f.create(); await f.start({ maxPlannerCalls: 3 });
      const result = await f.tick();
      assert.equal(result.status, 'BLOCKED');
      assert.equal(result.plannerCalls, 3);
      assert.equal(result.attempts, 1);
      assert.equal(f.plans, 3);
      assert.equal(f.effects, 0);
      assert.equal(fs.existsSync(path.join(f.root, 'result.txt')), false);
      await f.reopen();
      assert.equal((await f.status()).plannerCalls, 3);
      assert.equal((await f.tick()).skipped, true);
      assert.equal(f.plans, 3);
    } finally { await f.dispose(); }
  });
}
