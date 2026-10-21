import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function freePort() {
  const s = net.createServer();
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  const p = s.address().port;
  await new Promise(resolve => s.close(resolve));
  return p;
}
async function rpc(port, method, params = undefined) {
  const result = await fetch('http://127.0.0.1:' + port + '/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 6, method, ...(params ? { params } : {}) }),
    signal: AbortSignal.timeout(1600)
  });
  assert.equal(result.status, 200);
  return result.json();
}
test('native Notion tools are discoverable by real Commander MCP route and fail closed without credentials', { timeout: 22000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-notion-http-'));
  const port = await freePort();
  const callbackPort = await freePort();
  const config = JSON.parse(fs.readFileSync(path.join(repo, 'config.json'), 'utf8'));
  config.host = '127.0.0.1';
  config.port = port;
  config.allowedRoots = [tmp];
  config.auditLog = path.join(tmp, 'audit.jsonl');
  config.runtimeState = path.join(tmp, 'runtime.json');
  config.autoUpdate = { enabled: false };
  config.asyncOperations = { enabled: false };
  config.powerMode = { enabled: false, fullFilesystem: false };
  config.durableWorkflows = { enabled: false };
  config.notion = {
    enabled: true,
    clientId: '123e4567-e89b-42d3-a456-426614174000',
    redirectUri: 'http://127.0.0.1:' + callbackPort + '/notion/callback',
    allowWrites: false
  };
  const configPath = path.join(tmp, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  const env = { ...process.env, REMOTE_COMMANDER_CONFIG: configPath };
  delete env.REMOTE_COMMANDER_NOTION_CLIENT_SECRET;
  const child = spawn(process.execPath, [path.join(repo, 'src', 'server-v0.3.mjs')], { cwd: repo, env, windowsHide: true, stdio: 'ignore' });
  try {
    let listing, ready = false;
    for (let attempt = 0; attempt < 45; attempt++) {
      if (child.exitCode !== null) throw new Error('server exited before readiness: ' + child.exitCode);
      try {
        listing = await rpc(port, 'tools/list');
        ready = true;
        break;
      } catch { await new Promise(resolve => setTimeout(resolve, 160)); }
    }
    assert.equal(ready, true, 'Commander did not start on isolated localhost port');
    const tools = listing.result.tools.map(item => item.name);
    for (const name of ['notion_status', 'notion_connect_start', 'notion_verify', 'notion_search', 'notion_get_page', 'notion_create_page']) {
      assert.ok(tools.includes(name), 'missing tool ' + name);
    }
    const response = await rpc(port, 'tools/call', { name: 'notion_status', arguments: {} });
    assert.equal(response.result.isError ?? false, false);
    const text = response.result.content.find(item => item.type === 'text').text;
    const state = JSON.parse(text);
    assert.equal(state.enabled, true);
    assert.equal(state.connected, false);
    assert.equal(state.oauthConfigured, false);
    assert.equal(JSON.stringify(state).includes('access_token'), false);
    const failedMutation = await rpc(port, 'tools/call', { name: 'notion_create_page',
      arguments: { parentPageId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', title: 'Forbidden' } });
    assert.equal(failedMutation.result.isError, true);
  } finally {
    child.kill();
    await new Promise(resolve => {
      if (child.exitCode !== null) resolve();
      else { child.once('close', resolve); setTimeout(resolve, 3000).unref(); }
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
