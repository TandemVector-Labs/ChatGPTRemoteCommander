import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NotionEngine, createNotionTools, createNotionVault } from '../src/notion-engine.mjs';

const workspace = '11111111-2222-3333-4444-555555555555';
const page = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const originalSecret = process.env.REMOTE_COMMANDER_NOTION_CLIENT_SECRET;
function fakeVault() {
  let stored = null;
  return {
    available: true, backend: 'fixture-memory',
    async load() { return stored; },
    async save(value) { stored = structuredClone(value); }
  };
}
function mockResponse(status, body, headers = {}) {
  return { status, ok: status >= 200 && status < 300, headers: { get: key => headers[key.toLowerCase()] ?? null },
    json: async () => body };
}
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
test('opt-in and disconnected status expose no credentials', async () => {
  const vault = fakeVault();
  const engine = new NotionEngine({ config: {}, vault });
  assert.deepEqual(await engine.status(), { enabled: false, connected: false });
  await assert.rejects(engine.bearer(), /NOTION_DISABLED/);
  const configured = new NotionEngine({ config: { enabled: true }, vault });
  const status = await configured.status();
  assert.equal(status.connected, false);
  assert.equal(status.vaultAvailable, true);
  assert.equal(JSON.stringify(status).includes('access_token'), false);
  await assert.rejects(configured.getPage(page), /NOTION_NOT_CONNECTED/);
});
test('login state protected, callback exchanges token, stores in vault and reads page', async () => {
  process.env.REMOTE_COMMANDER_NOTION_CLIENT_SECRET = 'test-only-secret-not-real';
  const port = await freePort();
  const vault = fakeVault();
  const seen = [];
  const engine = new NotionEngine({
    config: { enabled: true, clientId: '123e4567-e89b-42d3-a456-426614174000',
      redirectUri: 'http://127.0.0.1:' + port + '/notion/callback', allowWrites: true },
    vault,
    fetchImpl: async (url, options) => {
      seen.push({ url, method: options.method });
      if (url.endsWith('/oauth/token')) {
        assert.equal(options.headers.Authorization.startsWith('Basic '), true);
        assert.equal(JSON.parse(options.body).grant_type, 'authorization_code');
        return mockResponse(200, { access_token: 'fixture-access-PRIVATE', refresh_token: 'fixture-refresh-PRIVATE',
          workspace_id: workspace, workspace_name: 'Fixture Workspace' });
      }
      assert.equal(options.headers.Authorization, 'Bearer ' + 'fixture-access-PRIVATE');
      if (url.endsWith('/users/me')) return mockResponse(200, { object: 'user', id: workspace });
      if (url.includes('/pages/')) return mockResponse(200, { object: 'page', id: page, url: 'https://notion.so/example' });
      if (url.endsWith('/search')) return mockResponse(200, { results: [{ object:'page', id: page,
        properties:{ title:{ title:[{ plain_text: 'Fixture' }] } } }], has_more:false });
      if (url.endsWith('/pages') && options.method === 'POST') return mockResponse(200, { object:'page', id: page });
      throw new Error('unexpected fixture endpoint');
    }
  });
  try {
    const begin = await engine.connectStart();
    assert.equal(begin.status, 'AWAITING_USER_LOGIN');
    const repeated = await engine.connectStart();
    assert.equal(repeated.authorizationUrl, begin.authorizationUrl, 'repeated login must reuse live callback');
    const authorize = new URL(begin.authorizationUrl);
    assert.equal(authorize.origin, 'https://api.notion.com');
    assert.ok(authorize.searchParams.get('state'));
    const invalid = await fetch('http://127.0.0.1:' + port + '/notion/callback?state=bad&code=fake');
    assert.equal(invalid.status, 400);
    const valid = await fetch('http://127.0.0.1:' + port + '/notion/callback?state='
      + authorize.searchParams.get('state') + '&code=test-code');
    assert.equal(valid.status, 200);
    assert.equal((await engine.status()).connected, true);
    assert.equal((await engine.status()).workspaceId, workspace);
    assert.equal((await engine.verify()).id, workspace);
    assert.ok((await engine.status()).lastVerifiedAt);
    assert.equal((await engine.getPage(page)).id, page);
    assert.equal((await engine.search('Fixture')).results[0].title, 'Fixture');
    assert.equal((await engine.createPage(page, 'Document')).id, page);
    assert.equal(seen.length, 5);
    assert.equal(JSON.stringify(await engine.status()).includes('PRIVATE'), false);
  } finally {
    engine.listener?.close();
    if (originalSecret === undefined) delete process.env.REMOTE_COMMANDER_NOTION_CLIENT_SECRET;
    else process.env.REMOTE_COMMANDER_NOTION_CLIENT_SECRET = originalSecret;
  }
});
test('OAuth setup fails before any HTTP call if secure vault unavailable', async () => {
  const notion = new NotionEngine({
    config: { enabled:true, clientId: '123e4567-e89b-42d3-a456-426614174000',
      redirectUri:'http://127.0.0.1:49731/notion/callback' },
    vault: { available:false, backend:'unsupported', async load(){return null;} }
  });
  await assert.rejects(notion.connectStart(), /NOTION_VAULT_UNAVAILABLE/);
});
test('read rate limit 429 retries safely; unsafe create does not retry', async () => {
  let readAttempts = 0;
  const vault = fakeVault();
  await vault.save({ access_token: 'local-fixture', workspace_id: workspace });
  const engine = new NotionEngine({
    config: { enabled: true, allowWrites: true }, vault,
    fetchImpl: async (url, options) => {
      if (options.method === 'GET') {
        readAttempts++;
        return readAttempts === 1 ? mockResponse(429, {}, { 'retry-after':'0' }) : mockResponse(200, { object:'page', id:page });
      }
      return mockResponse(503, {});
    }
  });
  assert.equal((await engine.getPage(page)).id, page);
  assert.equal(readAttempts, 2);
  await assert.rejects(engine.createPage(page,'Write'), /NOTION_HTTP_503/);
  assert.equal((await engine.status()).connected, true);
});
test('mutation disabled by default and strict endpoint validation', async () => {
  const vault = fakeVault();
  await vault.save({ access_token: 'fixture', workspace_id: workspace });
  const engine = new NotionEngine({ config:{ enabled:true }, vault,
    fetchImpl: async () => { throw new Error('network should not have been touched'); } });
  assert.throws(() => engine.createPage(page,'Blocked'), /NOTION_WRITES_DISABLED/);
  assert.throws(() => engine.getPage('../admin'), /NOTION_PAGE_ID_INVALID/);
  assert.throws(() => engine.search('a'.repeat(170)), /NOTION_QUERY_INVALID/);
});
test('MCP definitions do not expose secrets or general-purpose HTTP execution', () => {
  const notion = createNotionTools({ config:{ enabled:true }, vault:fakeVault() });
  assert.deepEqual(notion.definitions.map(x=>x.name), [
    'notion_status', 'notion_connect_start', 'notion_verify', 'notion_search', 'notion_get_page', 'notion_create_page'
  ]);
  const schema = JSON.stringify(notion.definitions);
  assert.equal(schema.includes('clientSecret'), false);
  assert.equal(schema.includes('access_token'), false);
});

test('refresh token rotation only retries safe read after 401', async () => {
  const old = process.env.REMOTE_COMMANDER_NOTION_CLIENT_SECRET;
  process.env.REMOTE_COMMANDER_NOTION_CLIENT_SECRET = 'synthetic-secret';
  const vault = fakeVault();
  await vault.save({ access_token: 'expired-fixture', refresh_token: 'old-fixture', workspace_id: workspace });
  let calls = 0;
  const engine = new NotionEngine({ config: { enabled: true,
    clientId: '123e4567-e89b-42d3-a456-426614174000' }, vault,
    fetchImpl: async (url, options) => {
      calls++;
      if (url.endsWith('/oauth/token')) {
        assert.equal(JSON.parse(options.body).refresh_token, 'old-fixture');
        return mockResponse(200, { access_token: 'renewed-fixture', refresh_token: 'rotated-fixture' });
      }
      return options.headers.Authorization === 'Bearer expired-fixture'
        ? mockResponse(401, {}) : mockResponse(200, { object:'page', id:page });
    } });
  try {
    assert.equal((await engine.getPage(page)).id, page);
    assert.equal(calls, 3);
    assert.equal((await vault.load()).refresh_token, 'rotated-fixture');
  } finally {
    if (old === undefined) delete process.env.REMOTE_COMMANDER_NOTION_CLIENT_SECRET;
    else process.env.REMOTE_COMMANDER_NOTION_CLIENT_SECRET = old;
  }
});
test('Windows vault protects and restores only synthetic credentials', { skip:process.platform !== 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-notion-dpapi-'));
  try {
    const vault = createNotionVault({ profile:'synthetic-test', directory:dir });
    assert.equal(vault.available, true);
    assert.equal(await vault.load(), null);
    await vault.save({ access_token:'SYNTHETIC_TEST_ONLY', workspace_id:workspace });
    const files = fs.readdirSync(dir);
    assert.equal(files.length,1);
    assert.equal(fs.readFileSync(path.join(dir, files[0]), 'utf8').includes('SYNTHETIC_TEST_ONLY'), false);
    assert.equal((await vault.load()).access_token, 'SYNTHETIC_TEST_ONLY');
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});

test('denied OAuth consent consumes state and closes callback without sending credentials', async () => {
  const old = process.env.REMOTE_COMMANDER_NOTION_CLIENT_SECRET;
  process.env.REMOTE_COMMANDER_NOTION_CLIENT_SECRET = 'synthetic-secret';
  const port = await freePort();
  const engine = new NotionEngine({ config: { enabled:true, clientId:'123e4567-e89b-42d3-a456-426614174000',
    redirectUri:'http://127.0.0.1:' + port + '/notion/callback' },
    vault: fakeVault(), fetchImpl: async () => { throw new Error('network must not be used on denial'); } });
  try {
    const authorization = await engine.connectStart();
    const state = new URL(authorization.authorizationUrl).searchParams.get('state');
    const response = await fetch('http://127.0.0.1:' + port + '/notion/callback?error=access_denied&state=' + state);
    assert.equal(response.status, 400);
    assert.equal(engine.pending, null);
    assert.equal(engine.listener, null);
    assert.equal((await engine.status()).connected, false);
  } finally {
    engine.listener?.close();
    if (old === undefined) delete process.env.REMOTE_COMMANDER_NOTION_CLIENT_SECRET;
    else process.env.REMOTE_COMMANDER_NOTION_CLIENT_SECRET = old;
  }
});
test('rate limit longer than maximum local wait never violates server Retry-After', async () => {
  const vault = fakeVault();
  await vault.save({ access_token: 'fixture', workspace_id: workspace });
  let attempts = 0;
  const engine = new NotionEngine({ config: { enabled:true }, vault,
    fetchImpl: async () => { attempts++; return mockResponse(429, {}, { 'retry-after': '45' }); } });
  await assert.rejects(engine.getPage(page), /NOTION_RATE_LIMIT_RETRY_LATER/);
  assert.equal(attempts, 1);
});
