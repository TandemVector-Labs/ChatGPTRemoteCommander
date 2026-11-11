import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./concurrency-smoke.mjs', import.meta.url), 'utf8');
const start = source.indexOf('async function waitForHealth() {');
const end = source.indexOf('\nasync function waitForRuntimeState(', start);
assert.ok(start !== -1 && end > start, 'startup health function must remain present');
const implementation = source.slice(start, end).trim();

function fixture({ platform = 'linux', reply, initialExit = null, exitAtMs = null }) {
  let nowMs = 10000;
  const startedAt = nowMs;
  let fetchCalls = 0;
  const timeoutValues = [];
  const server = { exitCode: initialExit, signalCode: null };
  const vmContext = {
    Date: { now: () => nowMs },
    process: { platform },
    server,
    port: 47931,
    serverOutput: '[fixture-only-output]',
    AbortSignal: {
      timeout: (ms) => {
        assert.ok(Number.isInteger(ms) && ms > 0 && ms <= 1000);
        timeoutValues.push(ms);
        return { fixtureTimeoutMs: ms };
      },
    },
    fetch: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:47931/health');
      assert.ok(options?.signal?.fixtureTimeoutMs > 0, 'each health fetch must have a bounded abort signal');
      fetchCalls++;
      return reply({ fetchCalls, nowMs, timeoutMs: options.signal.fixtureTimeoutMs, advance: (ms) => { nowMs += ms; } });
    },
    setTimeout: (resolve, ms) => {
      assert.equal(ms, 100);
      nowMs += ms;
      if (exitAtMs != null && nowMs - startedAt >= exitAtMs) server.exitCode = 17;
      resolve();
    },
  };
  const execute = () => vm.runInNewContext(implementation + '\nwaitForHealth();', vmContext, { timeout: 3000 });
  return { execute, getElapsedMs: () => nowMs - startedAt, getFetchCalls: () => fetchCalls, timeoutValues };
}

test('startup health: initial successful HTTP health passes without waiting', async () => {
  const f = fixture({ reply: () => ({ ok: true }) });
  await f.execute();
  assert.equal(f.getFetchCalls(), 1);
  assert.equal(f.getElapsedMs(), 0);
});

test('startup health: transient refused/503 responses retry then pass', async () => {
  const f = fixture({ reply: ({ fetchCalls }) => {
    if (fetchCalls === 1) throw new Error('ECONNREFUSED fixture');
    return { ok: fetchCalls >= 4 };
  } });
  await f.execute();
  assert.equal(f.getFetchCalls(), 4);
  assert.equal(f.getElapsedMs(), 300);
});

test('startup health: an already exited child fails closed without a request', async () => {
  const f = fixture({ initialExit: 17, reply: () => ({ ok: true }) });
  await assert.rejects(f.execute(), /exited before health/i);
  assert.equal(f.getFetchCalls(), 0);
});

test('startup health: early child exit while polling stops promptly', async () => {
  const f = fixture({ exitAtMs: 200, reply: () => ({ ok: false }) });
  await assert.rejects(f.execute(), /exited before health/i);
  assert.equal(f.getFetchCalls(), 2);
  assert.equal(f.getElapsedMs(), 200);
});

for (const [platform, expectedMs] of [['linux', 15000], ['win32', 30000]]) {
  test('startup health: ' + platform + ' deadline stays bounded to ' + expectedMs + 'ms', async () => {
    const f = fixture({ platform, reply: () => ({ ok: false }) });
    await assert.rejects(f.execute(), /startup deadline/i);
    assert.equal(f.getElapsedMs(), expectedMs);
    assert.equal(f.getFetchCalls(), expectedMs / 100);
    assert.ok(f.timeoutValues.length > 0);
    assert.ok(f.timeoutValues.every((x) => x <= 1000));
  });
}

test('startup health: a hung fetch that respects AbortSignal cannot evade the deadline', async () => {
  const f = fixture({ platform: 'linux', reply: ({ timeoutMs, advance }) => {
    advance(timeoutMs);
    throw new Error('AbortError fixture');
  } });
  await assert.rejects(f.execute(), /startup deadline/i);
  assert.ok(f.getElapsedMs() >= 15000 && f.getElapsedMs() <= 15100);
  assert.ok(f.getFetchCalls() >= 10 && f.getFetchCalls() <= 20);
});
