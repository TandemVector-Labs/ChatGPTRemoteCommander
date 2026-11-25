import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { observeOperationChild } from '../src/operation-child-lifecycle.mjs';

// No subprocess, real clock, filesystem mutation, kill, model, or worker stdin import.
function fixture({ kill, cancel = () => false } = {}) {
  let sequence = 0;
  const scheduled = new Map();
  const timers = {
    setTimeout: (fn, delay) => { const key = ++sequence; scheduled.set(key, { kind: 'timeout', fn, delay }); return key; },
    setInterval: (fn, delay) => { const key = ++sequence; scheduled.set(key, { kind: 'interval', fn, delay }); return key; },
    clearTimeout: key => scheduled.delete(key), clearInterval: key => scheduled.delete(key)
  };
  const child = new EventEmitter();
  child.pid = 123; child.exitCode = null; child.signalCode = null;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  const destroyed = { stdout: 0, stderr: 0 };
  child.stdout.destroy = () => { destroyed.stdout++; };
  child.stderr.destroy = () => { destroyed.stderr++; };
  const stdout = [], stderr = [], killed = [];
  const observed = observeOperationChild(child, {
    stdout, stderr, timeoutMs: 5000, cancellationRequested: cancel, timers,
    killOwnedChild: pid => { killed.push(pid); kill?.(child); }
  });
  const timeout = delay => {
    for (const [key, timer] of [...scheduled]) if (timer.kind === 'timeout' && timer.delay === delay) {
      scheduled.delete(key); timer.fn();
    }
  };
  const poll = () => { for (const timer of [...scheduled.values()]) if (timer.kind === 'interval') timer.fn(); };
  const exit = (code, signal = null) => { child.exitCode = code; child.signalCode = signal; child.emit('exit', code, signal); };
  const close = (code, signal = null) => child.emit('close', code, signal);
  const clean = () => {
    assert.equal(scheduled.size, 0);
    for (const name of ['error', 'exit', 'close']) assert.equal(child.listenerCount(name), 0);
    assert.equal(child.stdout.listenerCount('data'), 0); assert.equal(child.stderr.listenerCount('data'), 0);
  };
  return { child, scheduled, observed, stdout, stderr, killed, destroyed, timeout, poll, exit, close, clean };
}

test('exit and close during held persistence are captured before the first await', async () => {
  const h = fixture(); let release;
  const persistence = new Promise(resolve => { release = resolve; });
  const run = (async () => { await persistence; return h.observed.outcome; })();
  h.child.stdout.emit('data', Buffer.from('done'));
  h.child.stderr.emit('data', Buffer.from('warning'));
  h.exit(0); h.close(0); release();
  assert.deepEqual(await run, { code: 0, signal: null, stdioComplete: true, timedOut: false, cancelRequested: false });
  assert.equal(Buffer.concat(h.stdout).toString(), 'done'); assert.equal(Buffer.concat(h.stderr).toString(), 'warning');
  assert.deepEqual(h.killed, []); h.clean();
});

test('immediate nonzero exit remains FAILED evidence, not a success inference', async () => {
  const h = fixture(); h.exit(7); h.close(7);
  assert.equal((await h.observed.outcome).code, 7); h.clean();
});

test('spawn error during held persistence resolves a tagged error without early rejection', async () => {
  const h = fixture(); let release;
  const persistence = new Promise(resolve => { release = resolve; });
  const run = (async () => { await persistence; return h.observed.outcome; })();
  const error = new Error('MOCK_ENOENT'); h.child.emit('error', error);
  await Promise.resolve(); release();
  assert.equal((await run).error, error); assert.deepEqual(h.killed, []); h.clean();
});

test('exit preserves trailing output until close and stops execution timeout/cancel PID use', async () => {
  const h = fixture({ cancel: () => true }); h.exit(0);
  h.child.stdout.emit('data', Buffer.from('trailing')); h.poll(); h.timeout(5000); h.close(0);
  assert.equal((await h.observed.outcome).stdioComplete, true);
  assert.equal(Buffer.concat(h.stdout).toString(), 'trailing'); assert.deepEqual(h.killed, []); h.clean();
});

test('descendant-held stdio has bounded drain with incomplete-output evidence and no exited PID kill', async () => {
  const h = fixture({ cancel: () => true }); h.exit(0); h.poll(); h.timeout(5000); h.timeout(2000);
  const result = await h.observed.outcome;
  assert.equal(result.code, 0); assert.equal(result.stdioComplete, false);
  assert.equal(result.cancelRequested, false); assert.equal(result.timedOut, false);
  assert.deepEqual(h.destroyed, { stdout: 1, stderr: 1 }); assert.deepEqual(h.killed, []); h.clean();
});

test('forced drain remains incomplete even if destroying streams synchronously causes close', async () => {
  const h = fixture(); h.child.stdout.destroy = () => h.close(0);
  h.exit(0); h.timeout(2000);
  assert.equal((await h.observed.outcome).stdioComplete, false); h.clean();
});

test('duplicate exit/close callbacks settle once and remove all owned timers/listeners', async () => {
  const h = fixture(); let count = 0;
  const result = h.observed.outcome.then(value => { count++; return value; });
  h.exit(0); h.close(0); h.close(9); h.exit(9); h.timeout(2000);
  assert.equal((await result).code, 0); assert.equal(count, 1); h.observed.dispose(); h.clean();
});

test('timeout observes owned child termination and preserves timeout classification', async () => {
  const h = fixture({ kill: child => { child.exitCode = null; child.signalCode = 'SIGTERM'; child.emit('exit', null, 'SIGTERM'); child.emit('close', null, 'SIGTERM'); } });
  h.timeout(5000); const result = await h.observed.outcome;
  assert.equal(result.timedOut, true); assert.equal(result.cancelRequested, false); assert.equal(result.signal, 'SIGTERM');
  assert.deepEqual(h.killed, [123]); h.clean();
});

test('cancellation observes owned child termination once and preserves cancellation classification', async () => {
  const h = fixture({ cancel: () => true, kill: child => { child.signalCode = 'SIGTERM'; child.emit('exit', null, 'SIGTERM'); child.emit('close', null, 'SIGTERM'); } });
  h.poll(); h.poll(); const result = await h.observed.outcome;
  assert.equal(result.cancelRequested, true); assert.equal(result.timedOut, false); assert.deepEqual(h.killed, [123]); h.clean();
});

for (const kind of ['timeout', 'cancel']) test(`${kind} without termination event settles boundedly as unconfirmed, never success`, async () => {
  const h = fixture({ cancel: () => true });
  if (kind === 'timeout') h.timeout(5000); else h.poll();
  h.poll(); h.timeout(2000); const result = await h.observed.outcome;
  assert.equal(result.error?.message, 'CHILD_TERMINATION_UNCONFIRMED');
  assert.equal(result.timedOut, kind === 'timeout'); assert.equal(result.cancelRequested, kind === 'cancel');
  assert.deepEqual(h.killed, [123]); assert.deepEqual(h.destroyed, { stdout: 1, stderr: 1 }); h.clean();
});

test('completed PID cache without exit event cannot be killed or mislabeled as timeout', async () => {
  const h = fixture(); h.child.exitCode = 0; h.timeout(5000); h.timeout(2000);
  const result = await h.observed.outcome;
  assert.equal(result.code, 0); assert.equal(result.timedOut, false); assert.equal(result.stdioComplete, false);
  assert.deepEqual(h.killed, []); h.clean();
});

test('changed child identity fails closed without using another PID', async () => {
  const h = fixture(); h.child.pid = 999; h.timeout(5000);
  assert.equal((await h.observed.outcome).error?.message, 'CHILD_IDENTITY_UNPROVEN');
  assert.deepEqual(h.killed, []); h.clean();
});

test('source wiring installs lifecycle synchronously post-spawn and preserves receipt-before-state', () => {
  const source = readFileSync(new URL('../tools/operation-worker.mjs', import.meta.url), 'utf8');
  const main = source.slice(source.indexOf('async function main()'));
  const spawn = main.indexOf('currentChild = spawn(');
  const observer = main.indexOf('observed = observeOperationChild(currentChild, {');
  const persistence = main.indexOf('await atomicJson(spec.statePath, {', observer);
  assert.ok(spawn >= 0 && observer > spawn && persistence > observer);
  assert.equal(main.slice(spawn, observer).includes('await '), false);
  assert.ok(main.includes('outcome = await observed.outcome;'));
  assert.ok(main.includes('if (outcome.error) throw outcome.error;'));
  assert.ok(main.indexOf('await atomicJson(spec.resultPath, receipt);') < main.lastIndexOf('await atomicJson(spec.statePath, {'));
  assert.ok(main.includes('receipt.operationId === currentSpec.operationId'));
  assert.ok(main.includes('receipt.inputHash === currentSpec.inputHash'));
});
