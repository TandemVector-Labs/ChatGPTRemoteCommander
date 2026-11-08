import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { parseArgs, runDoctor, validateEndpoint } from '../tools/doctor.mjs';

test('validateEndpoint accepts loopback MCP URLs', () => {
  assert.equal(validateEndpoint('http://127.0.0.1:47831/mcp').hostname, '127.0.0.1');
  assert.equal(validateEndpoint('http://[::1]:47831/mcp').hostname, '[::1]');
});

test('validateEndpoint rejects remote hosts and URL secrets', () => {
  assert.throws(() => validateEndpoint('https://example.com/mcp'), /loopback-only/);
  assert.throws(() => validateEndpoint('http://user:pass@127.0.0.1:47831/mcp'), /credentials/);
  assert.throws(() => validateEndpoint('http://127.0.0.1:47831/mcp?token=x'), /query/);
});

test('doctor rejects noncanonical, DNS, privileged-port and path-confusion targets', () => {
  for (const address of [
    'http://localhost:47831/mcp',
    'http://example.invalid:47831/mcp',
    'https://127.0.0.1:47831/mcp',
    'http://0x7f000001:47831/mcp',
    'http://127.0.0.1/mcp',
    'http://127.0.0.1:80/mcp',
    'http://127.0.0.1:47831/foo/mcp',
    'http://127.0.0.1:47831/mcp/',
    'http://127.0.0.1:47831/mcp?secret=a',
    'http://127.0.0.1:47831/mcp#fragment',
    'http://127.0.0.1:47831/mcp\\host',
    'file:///etc/passwd'
  ]) {
    assert.throws(() => validateEndpoint(address), undefined, address);
  }
});

test('doctor rejects unsafe endpoint before making any HTTP request', async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => { hits += 1; res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    await assert.rejects(
      () => runDoctor({ endpoint: `http://127.0.0.1:${port}/foo/mcp` }),
      /exactly \/mcp/
    );
    assert.equal(hits, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('parseArgs enforces timeout bounds and known arguments', () => {
  assert.throws(() => parseArgs(['--timeout-ms', '20']), /between 500 and 30000/);
  assert.throws(() => parseArgs(['--wat']), /unknown argument/);
  const parsed = parseArgs(['--expected-device', 'device-a', '--json']);
  assert.equal(parsed.expectedDevice, 'device-a');
  assert.equal(parsed.json, true);
});

async function withMockServer({ version = '0.8.15', deviceName = 'device-a', tools, configSha256 = null }, fn) {
  const toolNames = tools || ['system_status', 'list_directory', 'read_text', 'write_text', 'run_project_command', 'gui_status'];
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url === '/health') {
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (body.method === 'tools/list') {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: toolNames.map((name) => ({ name })) } }));
      return;
    }
    if (body.method === 'tools/call' && body.params?.name === 'system_status') {
      res.end(JSON.stringify({
        jsonrpc: '2.0', id: body.id,
        result: {
          isError: false,
          structuredContent: {
            version, deviceName, configSha256,
            protocols: ['2026-07-28'],
            allowedRootsEnforced: false,
            powerMode: { enabled: true, fullFilesystem: true },
            guiControl: { enabled: true }
          }
        }
      }));
      return;
    }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'unknown' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    await fn(`http://127.0.0.1:${address.port}/mcp`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('runDoctor passes healthy matching server and config', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rc-doctor-'));
  try {
    const configPath = path.join(tmp, 'config.json');
    const raw = '{"host":"127.0.0.1"}\n';
    await writeFile(configPath, raw);
    const sha = createHash('sha256').update(raw).digest('hex');
    await withMockServer({ configSha256: sha }, async (endpoint) => {
      const report = await runDoctor({ endpoint, expectedVersion: '0.8.15', expectedDevice: 'device-a', configPath, timeoutMs: 10000 });
      assert.equal(report.ok, true);
      assert.equal(report.tools.count, 6);
      assert.equal(report.tools.guiCount, 1);
      assert.deepEqual(report.warnings, []);
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runDoctor reports version drift', async () => {
  await withMockServer({ version: '0.5.1' }, async (endpoint) => {
    const report = await runDoctor({ endpoint, expectedVersion: '0.8.10', timeoutMs: 10000 });
    assert.equal(report.ok, false);
    assert.equal(report.checks.find((item) => item.name === 'version').ok, false);
  });
});

test('runDoctor reports missing core tool', async () => {
  await withMockServer({ tools: ['system_status', 'list_directory'] }, async (endpoint) => {
    const report = await runDoctor({ endpoint, expectedVersion: '0.8.10', timeoutMs: 10000 });
    assert.equal(report.ok, false);
    assert.match(report.checks.find((item) => item.name === 'tools/list').detail, /missing:/);
  });
});
