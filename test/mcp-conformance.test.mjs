import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { requireNonElevatedLegacyHttp } from './fixtures/legacy-http-token-admission.mjs';

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const MODERN = '2026-07-28';

async function freePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

function modernMeta(version = MODERN) {
  return {
    'io.modelcontextprotocol/protocolVersion': version,
    'io.modelcontextprotocol/clientInfo': { name: 'remote-commander-conformance', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {}
  };
}

async function post(port, message, extraHeaders = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(message)
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null
  };
}

function modernHeaders(method, name, version = MODERN) {
  const headers = {
    'MCP-Protocol-Version': version,
    'Mcp-Method': method
  };
  if (name !== undefined) headers['Mcp-Name'] = name;
  return headers;
}

test('dual-era MCP contract, tool validation, cache hints and risk annotations', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-mcp-conformance-'));
  const serverRoot = path.join(root, 'server');
  const dataRoot = path.join(root, 'data');
  const port = await freePort();
  let child;

  try {
    await fs.mkdir(serverRoot, { recursive: true });
    await fs.mkdir(dataRoot, { recursive: true });
    await fs.cp(new URL('../src/', import.meta.url), path.join(serverRoot, 'src'), { recursive: true });

    const config = {
      capabilityProfile: { tier: 'STANDARD' },
      host: '127.0.0.1',
      port,
      allowedRoots: [dataRoot],
      allowedPrograms: ['node'],
      maxReadBytes: 1024 * 1024,
      maxWriteBytes: 1024 * 1024,
      maxCommandMs: 10000,
      auditLog: 'var/audit.jsonl',
      durableDelivery: { directory: path.join(root, 'delivery') },
      powerMode: {
        enabled: false,
        fullFilesystem: false,
        allowShell: true,
        allowProcessControl: true,
        allowPermanentDelete: false,
        backupRoot: path.join(root, 'backups'),
        maxFileBytes: 1024 * 1024,
        maxCommandMs: 10000,
        maxOutputBytes: 1024 * 1024,
        maxTerminalBufferBytes: 1024 * 1024,
        blockedShellPatterns: ['shutdown', 'Restart-Computer', 'Stop-Computer', 'logoff'],
        guiControl: { enabled: false }
      }
    };
    const configPath = path.join(serverRoot, 'config.json');
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    child = spawn(process.execPath, [path.join(serverRoot, 'src', 'server-v0.3.mjs')], {
      cwd: serverRoot,
      env: { ...process.env, REMOTE_COMMANDER_CONFIG: configPath },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });

    let healthy = false;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        if (response.ok) { healthy = true; break; }
      } catch {}
      await wait(25);
    }
    assert.equal(healthy, true, stderr);
    if(!(await requireNonElevatedLegacyHttp(t,port)))return;

    const legacyInit = await post(port, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy-test', version: '1.0.0' } }
    });
    assert.equal(legacyInit.status, 200);
    assert.equal(legacyInit.body.result.protocolVersion, '2025-11-25');
    assert.equal(legacyInit.body.result.serverInfo.name, 'chatgpt-remote-commander');
    assert.match(legacyInit.body.result.instructions, /at most 2 direct synchronous MCP tool calls/i);
    assert.match(legacyInit.body.result.instructions, /Do not rapidly poll status/i);

    const legacyList = await post(port, {
      jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}
    });
    assert.equal(legacyList.status, 200);
    assert.ok(Array.isArray(legacyList.body.result.tools));
    assert.equal('ttlMs' in legacyList.body.result, false);

    const writeTextDef = legacyList.body.result.tools.find(tool => tool.name === 'write_text');
    const writeFileDef = legacyList.body.result.tools.find(tool => tool.name === 'write_file');
    const createDirDef = legacyList.body.result.tools.find(tool => tool.name === 'create_directory');
    const runShellDef = legacyList.body.result.tools.find(tool => tool.name === 'run_shell');
    assert.equal(writeTextDef.annotations.destructiveHint, true);
    assert.equal(writeFileDef.annotations.destructiveHint, true);
    assert.equal(createDirDef.annotations.destructiveHint, false);
    assert.equal(createDirDef.annotations.idempotentHint, undefined);
    assert.equal(runShellDef.annotations.openWorldHint, true);

    const invalidLegacy = await post(port, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'list_directory', arguments: { path: dataRoot, depth: 999 } }
    });
    assert.equal(invalidLegacy.status, 200);
    assert.equal(invalidLegacy.body.result.isError, true);
    assert.match(invalidLegacy.body.result.content[0].text, /Input validation error/);
    assert.match(invalidLegacy.body.result.content[0].text, /maximum|<= 4|must be <= 4/i);

    const handlerError = await post(port, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'read_text', arguments: { path: path.join(dataRoot, 'missing.txt') } }
    });
    assert.equal(handlerError.status, 200);
    assert.equal(handlerError.body.result.isError, true);
    assert.ok(handlerError.body.result.content[0].text.length > 0);

    const unknown = await post(port, {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'no_such_tool', arguments: {} }
    });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.error.code, -32602);

    const discover = await post(port, {
      jsonrpc: '2.0', id: 10, method: 'server/discover',
      params: { _meta: modernMeta() }
    }, modernHeaders('server/discover'));
    assert.equal(discover.status, 200);
    assert.equal(discover.body.result.resultType, 'complete');
    assert.deepEqual(discover.body.result.supportedVersions, [MODERN]);
    assert.deepEqual(discover.body.result.capabilities.extensions['io.modelcontextprotocol/tasks'], {});
    assert.equal(discover.body.result.ttlMs, 30000);
    assert.equal(discover.body.result.cacheScope, 'private');
    assert.equal(discover.body.result._meta['io.modelcontextprotocol/serverInfo'].name, 'chatgpt-remote-commander');

    const modernList = await post(port, {
      jsonrpc: '2.0', id: 11, method: 'tools/list',
      params: { _meta: modernMeta() }
    }, modernHeaders('tools/list'));
    assert.equal(modernList.status, 200);
    assert.equal(modernList.body.result.resultType, 'complete');
    assert.equal(modernList.body.result.ttlMs, 30000);
    assert.equal(modernList.body.result.cacheScope, 'private');
    assert.ok(Array.isArray(modernList.body.result.tools));
    assert.ok(modernList.body.result.tools.some(tool => tool.name === 'delivery_status'));
    const deliveryStatus = await post(port, {
      jsonrpc: '2.0', id: 111, method: 'tools/call',
      params: { name: 'delivery_status', arguments: {}, _meta: modernMeta() }
    }, modernHeaders('tools/call', 'delivery_status'));
    assert.equal(deliveryStatus.status, 200);
    assert.equal(deliveryStatus.body.result.resultType, 'complete');
    assert.equal(deliveryStatus.body.result.structuredContent.durable, true);
    assert.equal(deliveryStatus.body.result.structuredContent.identityBoundary, 'TRUSTED_PROFILE_NOT_AUTHENTICATED_CHAT');

    const modernInvalid = await post(port, {
      jsonrpc: '2.0', id: 12, method: 'tools/call',
      params: {
        name: 'list_directory',
        arguments: { path: dataRoot, depth: 999 },
        _meta: modernMeta()
      }
    }, modernHeaders('tools/call', 'list_directory'));
    assert.equal(modernInvalid.status, 200);
    assert.equal(modernInvalid.body.result.resultType, 'complete');
    assert.equal(modernInvalid.body.result.isError, true);

    const modernInitialized = await post(port, {
      jsonrpc: '2.0', id: 13, method: 'notifications/initialized',
      params: { _meta: modernMeta() }
    }, modernHeaders('notifications/initialized'));
    assert.equal(modernInitialized.status, 200);
    assert.equal(modernInitialized.body.error.code, -32601);

    const unsupported = await post(port, {
      jsonrpc: '2.0', id: 14, method: 'tools/list',
      params: { _meta: modernMeta('2099-01-01') }
    }, modernHeaders('tools/list', undefined, '2099-01-01'));
    assert.equal(unsupported.status, 400);
    assert.equal(unsupported.body.error.code, -32022);

    const headerMismatch = await post(port, {
      jsonrpc: '2.0', id: 15, method: 'tools/list',
      params: { _meta: modernMeta() }
    }, modernHeaders('tools/call'));
    assert.equal(headerMismatch.status, 400);
    assert.equal(headerMismatch.body.error.code, -32020);

    const missingCapabilities = await post(port, {
      jsonrpc: '2.0', id: 16, method: 'tools/list',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN,
          'io.modelcontextprotocol/clientInfo': { name: 'bad-modern', version: '1.0.0' }
        }
      }
    }, modernHeaders('tools/list'));
    assert.equal(missingCapabilities.status, 400);
    assert.equal(missingCapabilities.body.error.code, -32021);
  } finally {
    if (child) {
      child.kill();
      await Promise.race([once(child, 'close'), wait(2000)]);
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
