// Isolated synthetic qualification of the experimental Commander Notion REST adapter.
// No account credentials, real HTTP requests, Notion writes, or model calls are used.
// This is NOT acceptance of the ChatGPT Notion connector or project brain behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NotionEngine } from '../src/notion-engine.mjs';

const target = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
function fakeVault() {
  const record = { access_token: 'fixture-token-only', workspace_id: 'fixture-workspace' };
  return { available: true, backend: 'fixture-memory',
    async load() { return structuredClone(record); },
    async save() { throw Error('unexpected credential mutation'); } };
}
function okPage() {
  return { ok: true, status: 200, headers: { get() { return null; } },
    async json() { return { object: 'page', id: target }; } };
}

test('provider-wide network outage: no false success, no unsafe write retry; later read recovery', async () => {
  let offline = true;
  const methods = [];
  const engine = new NotionEngine({
    config: { enabled: true, allowWrites: true },
    vault: fakeVault(),
    fetchImpl: async (_url, args) => {
      methods.push(args.method);
      if (offline) throw Object.assign(new Error('synthetic provider disconnected'), { code: 'ECONNREFUSED' });
      return okPage();
    }
  });
  await assert.rejects(engine.getPage(target), /NOTION_NETWORK_ERROR/);
  assert.deepEqual(methods, ['GET']);
  await assert.rejects(engine.createPage(target, 'Synthetic only'), /NOTION_NETWORK_ERROR/);
  assert.deepEqual(methods, ['GET', 'POST'], 'non-idempotent write must not retry');
  // A stored OAuth credential is not evidence of provider reachability.
  const meta = await engine.status();
  assert.equal(meta.connected, true);
  assert.equal(meta.lastVerifiedAt, null);
  offline = false;
  const recovered = await engine.getPage(target);
  assert.equal(recovered.object, 'page');
  assert.equal(recovered.id, target);
  assert.equal(JSON.stringify(recovered).includes('fixture-token-only'), false);
  assert.deepEqual(methods, ['GET', 'POST', 'GET']);
  assert.equal((await engine.status()).lastVerifiedAt, null,
    'read success must not impersonate /users/me connection verification');
});
test('synthetic request timeout fails closed before producing a success result', async () => {
  let calls = 0;
  const engine = new NotionEngine({ config: { enabled: true }, vault: fakeVault(),
    fetchImpl: async () => { calls++; const e = new Error('synthetic deadline'); e.name = 'TimeoutError'; throw e; }
  });
  await assert.rejects(engine.getPage(target), /NOTION_TIMEOUT/);
  assert.equal(calls, 1);
});
test('503 with long Retry-After defers immediately and avoids repeated load', async () => {
  let calls = 0;
  const engine = new NotionEngine({ config: { enabled: true }, vault: fakeVault(),
    fetchImpl: async () => {
      calls++;
      return { ok: false, status: 503, headers: { get: key => key.toLowerCase() === 'retry-after' ? '45' : null } };
    }
  });
  await assert.rejects(engine.getPage(target), /NOTION_RATE_LIMIT_RETRY_LATER/);
  assert.equal(calls, 1);
});
