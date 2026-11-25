import test from 'node:test';
import assert from 'node:assert/strict';
import { v102WindowsJobReceipt } from '../src/tools-v0.3.mjs';

const proof = (value) => 'RC_JOB_RESULT_JSON:' + JSON.stringify(value) + '\n';
const valid = { timedOut: false, termination: 'job-object', processId: 4102, exitCode: 0 };
const denied = /WINDOWS_JOB_RUNNER_COMPLETION_UNVERIFIED/;

test('native Job Object success requires exact well-formed completion and matching exit code', () => {
  assert.deepEqual(v102WindowsJobReceipt(proof(valid), 0), valid);
  assert.deepEqual(v102WindowsJobReceipt('child stderr\n' + proof(valid), 0), valid);
  const nonZero = { ...valid, exitCode: 303 };
  assert.deepEqual(v102WindowsJobReceipt(proof(nonZero), 1), nonZero);
});

test('native Job Object timeout requires matching runner status 124', () => {
  const timeout = { timedOut: true, termination: 'job-object', processId: 4102 };
  assert.deepEqual(v102WindowsJobReceipt(proof(timeout), 124), timeout);
  assert.throws(() => v102WindowsJobReceipt(proof(timeout), 0), denied);
});

test('unparseable or counterfeit Job Object marker is never accepted', () => {
  for (const raw of [
    '',
    'child stderr only\n',
    'RC_JOB_RESULT_JSON:{invalid}\n',
    proof({ ...valid, termination: 'taskkill-tree' }),
    proof({ ...valid, timedOut: 'false' }),
    proof({ ...valid, processId: 0 }),
    proof({ ...valid, processId: '4102' }),
    proof({ ...valid, exitCode: '0' }),
    proof({ ...valid, exitCode: -1 }),
    proof({ ...valid, exitCode: 2 }),
    proof({ ...valid, timedOut: true, exitCode: 0 }),
    proof({ ...valid, timedOut: false, exitCode: undefined }),
    proof(valid) + 'later stderr without trusted completion\n'
  ]) assert.throws(() => v102WindowsJobReceipt(raw, 0), denied);
});

test('status mismatch and signal-only completion fail closed', () => {
  assert.throws(() => v102WindowsJobReceipt(proof(valid), 1), denied);
  assert.throws(() => v102WindowsJobReceipt(proof(valid), null), denied);
  assert.throws(() => v102WindowsJobReceipt(proof(valid), undefined), denied);
});

test('last complete native result wins over earlier untrusted child markers', () => {
  const childMarker = proof({ ...valid, exitCode: 19 });
  assert.deepEqual(v102WindowsJobReceipt(childMarker + proof(valid), 0), valid);
});