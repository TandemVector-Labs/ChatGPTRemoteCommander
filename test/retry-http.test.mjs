import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { requireNonElevatedLegacyHttp } from './fixtures/legacy-http-token-admission.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}
async function rawPost(port, id, name, args) {
  const started = Date.now();
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
  });
  const text = await response.text();
  return { response, text, body: JSON.parse(text), elapsedMs: Date.now() - started };
}

test('HTTP retry hardening rejects long sync work before effect and bounds oversized responses', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-retry-http-'));
  const serverRoot = path.join(root, 'server');
  const dataRoot = path.join(root, 'data');
  const port = await freePort();
  let child;
  try {
    await fs.mkdir(serverRoot, { recursive: true });
    await fs.mkdir(dataRoot, { recursive: true });
    const canonicalDataRoot = await fs.realpath(dataRoot);
    await fs.cp(new URL('../src/', import.meta.url), path.join(serverRoot, 'src'), { recursive: true });
    const fixture = path.join(canonicalDataRoot, 'fixture.mjs');
    const effect = path.join(canonicalDataRoot, 'effect.txt');
    await fs.writeFile(fixture, `import fs from 'node:fs/promises'; await new Promise(r=>setTimeout(r,1000)); await fs.writeFile(${JSON.stringify(effect)},'effect');`);
    const largeSafe = path.join(canonicalDataRoot, 'large-safe.txt');
    const largeOversize = path.join(canonicalDataRoot, 'large-oversize.txt');
    await fs.writeFile(largeSafe, 'x'.repeat(5 * 1024 * 1024));
    await fs.writeFile(largeOversize, 'x'.repeat(9 * 1024 * 1024));
    const config = {
      capabilityProfile: { tier: 'STANDARD' },
      host: '127.0.0.1', port, allowedRoots: [canonicalDataRoot], allowedPrograms: ['node'],
      maxReadBytes: 16 * 1024 * 1024, maxWriteBytes: 1024 * 1024, maxCommandMs: 300000,
      auditLog: 'var/audit.jsonl', asyncOperations: { enabled: true, backgroundFirst: true },
      powerMode: { enabled: false, fullFilesystem: false, allowShell: false, allowProcessControl: false, allowPermanentDelete: false, guiControl: { enabled: false }, browserControl: { enabled: false } }
    };
    const configPath = path.join(serverRoot, 'config.json');
    await fs.writeFile(configPath, JSON.stringify(config));
    child = spawn(process.execPath, [path.join(serverRoot, 'src', 'server-v0.3.mjs')], { cwd: serverRoot, env: { ...process.env, REMOTE_COMMANDER_CONFIG: configPath }, stdio: ['ignore','pipe','pipe'] });
    let stderr = ''; child.stderr.on('data', c => { stderr += c.toString('utf8'); });
    let healthy = false;
    const startupDeadline = Date.now() + 30000;
    while (Date.now() < startupDeadline) {
      if (child.exitCode !== null) throw new Error(`retry fixture server exited before healthy: exitCode=${child.exitCode}; stderr=${stderr}`);
      try { const r=await fetch(`http://127.0.0.1:${port}/health`); if(r.ok){healthy=true;break;} } catch {}
      await wait(25);
    }
    assert.equal(healthy, true, `retry fixture server did not become healthy within 30000ms; stderr=${stderr}`);
    if(!(await requireNonElevatedLegacyHttp(t,port))){
      await assert.rejects(fs.stat(effect),{code:'ENOENT'});
      return;
    }

    const direct = await rawPost(port, 1, 'run_project_command', { program: 'node', args: [fixture], cwd: canonicalDataRoot, timeoutMs: 15001 });
    assert.equal(direct.response.status, 200);
    assert.ok(direct.elapsedMs < 1000, `long sync request was not rejected promptly: ${direct.elapsedMs}ms`);
    assert.equal(direct.body.result.isError, true);
    assert.match(direct.body.result.content[0].text, /10000|bounded read_terminal|maximum/);
    await wait(1200);
    await assert.rejects(fs.stat(effect), { code: 'ENOENT' });

    const safeLarge = await rawPost(port, 2, 'read_text', { path: largeSafe });
    assert.equal(safeLarge.response.status, 200);
    assert.equal(safeLarge.body.error, undefined);
    assert.equal(safeLarge.body.result.isError, true);
    assert.match(safeLarge.body.result.content[0].text, /SYNCHRONOUS_READ_REQUIRES_PAGING/);
    assert.ok(Buffer.byteLength(safeLarge.text, 'utf8') < 4096);

    const page = await rawPost(port, 3, 'read_text', { path: largeSafe, offset: 0, maxBytes: 262144 });
    assert.equal(page.response.status, 200);
    assert.equal(page.body.error, undefined);
    assert.equal(page.body.result.isError, false);
    assert.equal(page.body.result.structuredContent.bytes, 262144);
    assert.equal(page.body.result.structuredContent.nextOffset, 262144);
    assert.equal(page.body.result.structuredContent.truncated, true);
    assert.ok(Buffer.byteLength(page.text, 'utf8') < 1024 * 1024);

    const oversized = await rawPost(port, 4, 'read_text', { path: largeOversize });
    assert.equal(oversized.response.status, 200);
    assert.equal(oversized.body.result.isError, true);
    assert.match(oversized.body.result.content[0].text, /SYNCHRONOUS_READ_REQUIRES_PAGING/);
    assert.ok(Buffer.byteLength(oversized.text, 'utf8') < 4096);
  } finally {
    if (child && child.exitCode === null) { child.kill(); await Promise.race([once(child,'exit'), wait(2000)]); }
    await fs.rm(root, { recursive: true, force: true });
  }
});
