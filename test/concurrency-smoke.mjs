import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const root = path.resolve('test', '.tmp-concurrency-root');
const isolatedApp = path.resolve('test', '.tmp-concurrency-app');
const isolatedSrc = path.join(isolatedApp, 'src');
const configPath = path.resolve('test', '.tmp-concurrency-config.json');
const liveRuntimeStatePath = path.resolve('var', 'mcp-runtime.json');
const isolatedRuntimeStatePath = path.join(isolatedApp, 'var', 'mcp-runtime.json');
const port = 47931;
const endpoint = `http://127.0.0.1:${port}/mcp`;
const requestPrefix = `concurrency-${randomUUID()}`;

async function sha256IfPresent(filePath) {
  try {
    const data = await readFile(filePath);
    return createHash('sha256').update(data).digest('hex');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

const liveRuntimeStateBefore = await sha256IfPresent(liveRuntimeStatePath);

await rm(root, { recursive: true, force: true });
await rm(isolatedApp, { recursive: true, force: true });
await mkdir(root, { recursive: true });
await mkdir(isolatedApp, { recursive: true });
await cp(path.resolve('src'), isolatedSrc, { recursive: true });
const config = {
  host: '127.0.0.1', port, allowedRoots: [root],
  allowedPrograms: ['git', 'node'], maxReadBytes: 524288,
  maxWriteBytes: 524288, maxCommandMs: 30000,
  auditLog: path.join(root, 'audit.jsonl'),
  powerMode: { enabled: false, fullFilesystem: false, allowShell: false, allowProcessControl: false, allowPermanentDelete: false }
};
await writeFile(configPath, JSON.stringify(config, null, 2));

const server = spawn(process.execPath, [path.join(isolatedSrc, 'server-v0.3.mjs')], {
  env: { ...process.env, REMOTE_COMMANDER_CONFIG: configPath },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverOutputBytes = 0;
const captureOutput = (chunk) => { serverOutputBytes += chunk.byteLength; };
server.stdout.on('data', captureOutput);
server.stderr.on('data', captureOutput);
let serverExited = false;
let serverExitReason = 'NONE';
server.once('exit', (code, signal) => {
  serverExited = true;
  serverExitReason = code === null ? 'SIGNAL_' + String(signal ?? 'UNKNOWN') : 'CODE_' + String(code);
});
server.once('error', (error) => {
  serverExited = true;
  serverExitReason = 'SPAWN_' + (/^[A-Z0-9_]{1,32}$/.test(error?.code ?? '') ? error.code : 'ERROR');
});
process.once('exit', () => { try { server.kill('SIGTERM'); } catch {} });

// Use one bounded 30s startup budget for health and owned runtime state.
// A hosted Windows health probe exceeded the old ~10s window; cause remains
// unverified, so early process exit and per-probe failures remain observable.
const startupStartedAt = Date.now();
const startupDeadline = startupStartedAt + 30000;
async function waitForHealth() {
  let attempts = 0;
  let lastProbe = 'NOT_STARTED';
  while (Date.now() < startupDeadline) {
    if (serverExited || server.exitCode !== null || server.signalCode !== null) {
      throw new Error('CONCURRENCY_HEALTH_CHILD_EXIT ' + serverExitReason);
    }
    const remaining = Math.max(1, startupDeadline - Date.now());
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(Math.min(1000, remaining))
      });
      if (response.ok) return;
      lastProbe = 'HTTP_' + String(response.status);
    } catch (error) {
      const code = error?.cause?.code;
      lastProbe = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(code)
        ? code : error?.name === 'TimeoutError' ? 'FETCH_TIMEOUT' : 'FETCH_ERROR';
    }
    attempts += 1;
    const pause = Math.min(100, Math.max(0, startupDeadline - Date.now()));
    if (pause) await new Promise((resolve) => setTimeout(resolve, pause));
  }
  throw new Error('CONCURRENCY_HEALTH_STARTUP_TIMEOUT elapsedMs=' +
    (Date.now() - startupStartedAt) + ' attempts=' + attempts +
    ' probe=' + lastProbe + ' outputBytes=' + serverOutputBytes);
}

async function waitForRuntimeState(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(await readFile(isolatedRuntimeStatePath, 'utf8'));
      if (state.port === port && path.resolve(state.projectDir) === isolatedApp) return state;
      lastError = new Error('runtime state identity mismatch');
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const reason = lastError?.code === 'ENOENT' ? 'STATE_MISSING'
    : lastError instanceof SyntaxError ? 'STATE_INVALID_JSON' : 'STATE_IDENTITY';
  throw new Error('CONCURRENCY_STATE_STARTUP_TIMEOUT reason=' + reason +
    ' outputBytes=' + serverOutputBytes + ' childExited=' + serverExited);
}

let nextId = 1;
async function callTool(name, args = {}) {
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: nextId++, method: 'tools/call',
      params: { name, arguments: args }
    })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  if (body.error) throw new Error(body.error.message);
  assert.equal(body.result.isError, false);
  return body.result.structuredContent;
}

try {
  await waitForHealth();
  const isolatedState = await waitForRuntimeState(Math.max(1, startupDeadline - Date.now()));
  assert.equal(isolatedState.port, port);
  assert.equal(path.resolve(isolatedState.projectDir), isolatedApp);

  const readOnlyCalls = Array.from({ length: 40 }, (_, index) =>
    index % 2 === 0 ? callTool('system_status') : callTool('list_directory', { path: root, depth: 0 })
  );
  const readOnlyResults = await Promise.all(readOnlyCalls);
  assert.equal(readOnlyResults.length, 40);
  const distinctWrites = Array.from({ length: 20 }, (_, index) =>
    callTool('write_text', {
      requestId: `${requestPrefix}-parallel-${index}`,
      path: path.join(root, `parallel-${index}.txt`),
      content: `value-${index}`
    })
  );
  const distinctResults = await Promise.all(distinctWrites);
  assert.equal(distinctResults.length, 20);

  const shared = path.join(root, 'shared-append.txt');
  const tokens = Array.from({ length: 30 }, (_, index) => `token-${index.toString().padStart(2, '0')}\n`);
  await Promise.all(tokens.map((token, index) => callTool('write_text', {
    requestId: `${requestPrefix}-shared-${index}`,
    path: shared, content: token, mode: 'append'
  })));
  const sharedText = await readFile(shared, 'utf8');
  for (const token of tokens) {
    const count = sharedText.split(token).length - 1;
    assert.equal(count, 1, `missing/duplicate token: ${token.trim()}`);
  }
  assert.equal(sharedText.split(/\r?\n/).filter(Boolean).length, tokens.length);

  const status = await callTool('system_status');
  assert.equal(status.concurrency.httpConcurrent, true);
  assert.equal(status.concurrency.pathMutationLocks, true);
} finally {
  server.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => server.once('close', resolve)),
    new Promise((resolve) => setTimeout(resolve, 1500))
  ]);
  await rm(root, { recursive: true, force: true });
  await rm(configPath, { force: true });
  await rm(isolatedApp, { recursive: true, force: true });

  const liveRuntimeStateAfter = await sha256IfPresent(liveRuntimeStatePath);
  assert.equal(
    liveRuntimeStateAfter,
    liveRuntimeStateBefore,
    'concurrency smoke must never modify or restore the live runtime ownership marker'
  );
}

console.log('CONCURRENCY_SMOKE_PASS');
