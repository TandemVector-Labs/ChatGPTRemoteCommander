import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { probeWindowsAdministrator } from '../src/windows-admin-token.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function post(port, id, name, args) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args }
    })
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  if (body.error) throw new Error(body.error.message);
  if (body.result?.isError) throw new Error(body.result.content?.[0]?.text || 'tool error');
  return body.result.structuredContent;
}

async function waitTerminal(port, operationId) {
  const deadline = Date.now() + 15000;
  let id = 100;
  while (Date.now() < deadline) {
    const state = await post(port, id++, 'operation_status', { operationId });
    if (['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'UNCERTAIN'].includes(state.status)) return state;
    await wait(50);
  }
  throw new Error('operation did not reach terminal state');
}

test('HTTP async operation returns immediately, retry is idempotent, and output stays file-backed', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-async-http-'));
  const serverRoot = path.join(root, 'server');
  const dataRoot = path.join(root, 'data');
  const toolsRoot = path.join(serverRoot, 'tools');
  const stateRoot = path.join(root, 'operation-state');
  const port = await freePort();
  let child;
  let stderr='';
  let stdoutBytes=0;
  let phase='fixture-setup';

  try {
    await fs.mkdir(serverRoot, { recursive: true });
    await fs.mkdir(dataRoot, { recursive: true });
    const canonicalDataRoot = await fs.realpath(dataRoot);
    await fs.mkdir(toolsRoot, { recursive: true });
    await fs.cp(new URL('../src/', import.meta.url), path.join(serverRoot, 'src'), { recursive: true });
    await fs.copyFile(new URL('../tools/operation-worker.mjs', import.meta.url), path.join(toolsRoot, 'operation-worker.mjs'));
    const fixture = path.join(canonicalDataRoot, 'async-fixture.mjs');
    await fs.copyFile(new URL('./async-operation-fixture.mjs', import.meta.url), fixture);

    const config = {
      capabilityProfile: { tier: 'STANDARD' },
      host: '127.0.0.1',
      port,
      allowedRoots: [canonicalDataRoot],
      allowedPrograms: ['node'],
      maxReadBytes: 1024 * 1024,
      maxWriteBytes: 1024 * 1024,
      maxCommandMs: 10000,
      auditLog: 'var/audit.jsonl',
      asyncOperations: {
        enabled: true,
        backgroundFirst: true,
        stateDir: stateRoot,
        maxOutputBytes: 65536
      },
      powerMode: {
        enabled: false,
        fullFilesystem: false,
        allowShell: false,
        allowProcessControl: false,
        allowPermanentDelete: false,
        guiControl: { enabled: false },
        browserControl: { enabled: false }
      }
    };
    const configPath = path.join(serverRoot, 'config.json');
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    child = spawn(process.execPath, [path.join(serverRoot, 'src', 'server-v0.3.mjs')], {
      cwd: serverRoot,
      env: { ...process.env, REMOTE_COMMANDER_CONFIG: configPath },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stderr.on('data', (chunk) => { if (stderr.length < 8192) stderr += chunk.toString('utf8').slice(0,8192-stderr.length); });
    child.stdout.on('data', (chunk) => { stdoutBytes += chunk.length; });

    phase='server-startup';
    let healthy = false;
    // Release qualification runs test files in parallel. Keep startup bounded,
    // but give the copied fixture server 10s of process-start headroom; this is
    // independent of Commander's synchronous transport deadline.
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        if (response.ok) { healthy = true; break; }
      } catch {}
      await wait(25);
    }
    assert.equal(healthy, true, stderr || `server failed to become healthy; exitCode=${child.exitCode}`);

    phase='native-token-and-quarantine';
    const nativeToken = process.platform === 'win32'
      ? await probeWindowsAdministrator() : null;
    if(process.platform==='win32'){
      const safeToken={ok:nativeToken?.ok===true,isAdmin:nativeToken?.isAdmin===true,
        isSystem:nativeToken?.isSystem===true,elevation:nativeToken?.elevation??null,
        source:nativeToken?.source??null,code:nativeToken?.code??null};
      console.log('R157_ASYNC_HTTP_TOKEN_PROBE='+JSON.stringify(safeToken));
    }
    const url='http://127.0.0.1:'+port;
    const health = await (await fetch(url+'/health')).json();
    if(process.platform==='win32') console.log('R157_ASYNC_HTTP_QUARANTINE='+String(health.privilegedLegacyHttpQuarantined===true));
    if(nativeToken?.ok === true && nativeToken.isAdmin === true) {
      // Hosted Windows Actions may use an elevated Administrator token.
      // A legacy unauthenticated MCP path must remain quarantined.
      assert.equal(health.privilegedLegacyHttpQuarantined,true);
      const blocked=await fetch(url+'/mcp',{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})
      });
      assert.equal(blocked.status,403);
      assert.deepEqual(await blocked.json(),{error:'trusted_transport_required'});
      return t.skip('elevated native Windows token: fail-closed admission verified; positive STANDARD requires non-admin host');
    }
    assert.equal(health.privilegedLegacyHttpQuarantined,false,
      'STANDARD loopback fixture must be reachable by a verified non-elevated host token');

    const effect = path.join(canonicalDataRoot, 'effect.txt');
    const request = {
      requestId: 'http-retry-1',
      tool: 'run_project_command',
      arguments: {
        program: 'node',
        args: [fixture, 'effect', effect, '1200'],
        cwd: canonicalDataRoot,
        timeoutMs: 5000
      }
    };
    phase='operation-start';
    const startedAt = Date.now();
    const first = await post(port, 1, 'operation_start', request);
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 1000, `operation_start stayed open for ${elapsed}ms`);
    phase='idempotent-retry';
    const retry = await post(port, 2, 'operation_start', request);
    assert.equal(retry.operationId, first.operationId);
    assert.equal(retry.duplicate, true);

    phase='operation-terminal';
    const final = await waitTerminal(port, first.operationId);
    assert.equal(final.status, 'SUCCEEDED');
    assert.equal(await fs.readFile(effect, 'utf8'), 'x');

    phase='file-backed-result';
    const result = await post(port, 3, 'operation_result', { operationId: first.operationId, tailBytes: 1024 });
    assert.equal(result.state.status, 'SUCCEEDED');
    assert.equal(result.stdoutTail, 'effect-done');
    assert.equal(result.result.stdout.path.endsWith('stdout.log'), true);

    const durableState = await fs.readFile(path.join(stateRoot, 'operations', first.operationId, 'state.json'), 'utf8');
    assert.equal(durableState.includes(effect), false);
    assert.equal(durableState.includes(fixture), false);

    phase='large-output-start';
    const large = await post(port, 4, 'operation_start', {
      requestId: 'http-large-1',
      tool: 'run_project_command',
      arguments: {
        program: 'node',
        args: [fixture, 'large', '200000'],
        cwd: canonicalDataRoot,
        timeoutMs: 5000
      }
    });
    phase='large-output-terminal';
    await waitTerminal(port, large.operationId);
    phase='large-output-result';
    const largeResult = await post(port, 5, 'operation_result', { operationId: large.operationId, tailBytes: 512 });
    assert.equal(largeResult.result.stdout.totalBytes, 200000);
    assert.equal(largeResult.result.stdout.capturedBytes, 65536);
    assert.equal(largeResult.result.stdout.truncated, true);
    assert.equal(Buffer.byteLength(largeResult.stdoutTail), 512);
    assert.ok(JSON.stringify(largeResult).length < 10000);
  } catch (error) {
    const safeName=typeof error?.name==='string' && /^[A-Za-z0-9_]{1,48}$/.test(error.name) ? error.name : 'Error';
    const safeCode=typeof error?.code==='string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : null;
    const safeScalar=value=>typeof value==='boolean'||(typeof value==='number'&&Number.isFinite(value))||
      (typeof value==='string'&&/^[A-Za-z0-9_ .:-]{1,64}$/.test(value)) ? value : null;
    const assertion=error?.code==='ERR_ASSERTION' ? {
      operator:typeof error.operator==='string'&&/^[A-Za-z]{1,24}$/.test(error.operator)?error.operator:null,
      actual:safeScalar(error.actual),expected:safeScalar(error.expected)
    } : null;
    console.log('R157_ASYNC_HTTP_FAILURE_PHASE='+phase);
    console.log('R157_ASYNC_HTTP_FAILURE_NAME='+safeName);
    if(safeCode)console.log('R157_ASYNC_HTTP_FAILURE_CODE='+safeCode);
    if(phase==='server-startup'){
      const known=['ERR_MODULE_NOT_FOUND','ERR_INVALID_ARG_TYPE','ERR_UNKNOWN_FILE_EXTENSION','EACCES','EPERM','ENOENT','EADDRINUSE','SyntaxError','ReferenceError','TypeError','Error'];
      const stderrClass=known.find(kind=>stderr.includes(kind))??'UNCLASSIFIED';
      const serverDiag={exitCode:Number.isInteger(child?.exitCode)?child.exitCode:null,
        signalCode:['SIGTERM','SIGINT','SIGKILL'].includes(child?.signalCode)?child.signalCode:null,
        stderrClass,stderrBytes:Buffer.byteLength(stderr),stdoutBytes};
      console.log('R157_ASYNC_HTTP_SERVER_STARTUP='+JSON.stringify(serverDiag));
    }
    if(assertion)console.log('R157_ASYNC_HTTP_FAILURE_ASSERTION='+JSON.stringify(assertion));
    throw error;
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await Promise.race([once(child, 'exit'), wait(2000)]);
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
