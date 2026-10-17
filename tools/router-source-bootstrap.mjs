import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256File = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sha256Bytes = data => createHash('sha256').update(data).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const canonical = value => path.resolve(String(value));
const alive = pid => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };

export function assertRouterStatusUrl(url, expectedPort) {
  if (typeof url !== 'string' || url.length > 256 || url.includes('\\')) throw new Error('ROUTER_STATUS_URL_DENIED');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('ROUTER_STATUS_URL_DENIED'); }
  if (parsed.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(parsed.hostname)
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || parsed.pathname !== '/router/status'
      || !Number.isSafeInteger(expectedPort) || expectedPort < 1024 || expectedPort > 65535
      || Number(parsed.port) !== expectedPort || url !== parsed.href) {
    throw new Error('ROUTER_STATUS_URL_DENIED');
  }
  return parsed.href;
}

async function routerStatus(url) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error('ROUTER_STATUS_HTTP_' + response.status);
  const body = await response.json();
  if (body?.ok !== true || body?.router !== true) throw new Error('ROUTER_STATUS_INVALID');
  return body;
}
async function waitStatus(url, expectedSha, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const status = await routerStatus(url);
      last = status;
      if (status.sourceSha256 === expectedSha) return status;
    } catch {}
    await sleep(100);
  }
  throw new Error('ROUTER_SOURCE_READY_TIMEOUT' + (last?.sourceSha256 ? ':' + last.sourceSha256 : ''));
}
async function stopProcess(pid) {
  pid = Number(pid);
  if (!alive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 50 && alive(pid); i += 1) await sleep(100);
  if (alive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
    for (let i = 0; i < 30 && alive(pid); i += 1) await sleep(100);
  }
  if (alive(pid)) throw new Error('ROUTER_PROCESS_STOP_TIMEOUT');
}
function commandLine(pid) {
  pid = Number(pid);
  if (process.platform === 'win32') {
    const script = '$p=Get-CimInstance Win32_Process -Filter "ProcessId = ' + pid + '"; if($p){[Console]::Out.Write($p.CommandLine)}';
    const result = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error('ROUTER_PROCESS_QUERY_FAILED');
    return result.stdout || '';
  }
  return fs.readFileSync('/proc/' + pid + '/cmdline').toString('utf8').replaceAll('\0', ' ');
}
function verifyProcessIdentity(pid, port, stateFile) {
  if (!alive(pid)) throw new Error('ROUTER_PROCESS_MISSING');
  const cmd = commandLine(pid).replaceAll('\\', '/').toLowerCase();
  const state = canonical(stateFile).replaceAll('\\', '/').toLowerCase();
  if (!cmd.includes('stable-router.mjs') || !cmd.includes(String(port)) || !cmd.includes(state)) {
    throw new Error('ROUTER_PROCESS_IDENTITY_MISMATCH');
  }
}
function spawnRouter(source, port, stateFile, runtimeFile, logFile) {
  const projectDir = path.resolve(path.dirname(source), '..');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'a');
  try {
    const child = spawn(process.execPath, [
      source,
      '--listen-port', String(port),
      '--state-file', stateFile,
      '--runtime-file', runtimeFile
    ], {
      cwd: projectDir,
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true
    });
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(fd);
  }
}
export async function ensureRouterSource({ url, stateFile, runtimeFile, candidateSource, logFile }) {
  stateFile = canonical(stateFile);
  runtimeFile = canonical(runtimeFile);
  candidateSource = canonical(candidateSource);
  logFile = canonical(logFile);
  if (!fs.existsSync(candidateSource) || !fs.statSync(candidateSource).isFile()) throw new Error('ROUTER_CANDIDATE_SOURCE_MISSING');
  const candidateSha256 = sha256File(candidateSource);
  if (!fs.existsSync(runtimeFile)) throw new Error('ROUTER_RUNTIME_MISSING');
  const runtime = readJson(runtimeFile);
  const port = Number(runtime.port);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('ROUTER_RUNTIME_PORT_INVALID');
  url = assertRouterStatusUrl(url, port);
  const beforeStatus = await routerStatus(url);
  if (beforeStatus.sourceSha256 === candidateSha256) {
    return { ok: true, changed: false, sourceSha256: candidateSha256, pid: Number(readJson(runtimeFile).pid) };
  }
  const routeBytes = fs.readFileSync(stateFile);
  const routeHash = sha256Bytes(routeBytes);
  const route = JSON.parse(routeBytes.toString('utf8'));
  if (canonical(runtime.stateFile) !== stateFile || runtime.sourceSha256 !== beforeStatus.sourceSha256) throw new Error('ROUTER_RUNTIME_IDENTITY_MISMATCH');
  verifyProcessIdentity(runtime.pid, port, stateFile);
  const oldProject = canonical(route?.active?.projectDir || '');
  const oldSource = path.join(oldProject, 'src', 'stable-router.mjs');
  if (!fs.existsSync(oldSource)) throw new Error('ROUTER_ROLLBACK_SOURCE_MISSING');
  const oldSha256 = sha256File(oldSource);
  if (oldSha256 !== beforeStatus.sourceSha256) throw new Error('ROUTER_SOURCE_OWNERSHIP_MISMATCH');

  let replacementPid = null;
  let stoppedOld = false;
  try {
    await stopProcess(runtime.pid);
    stoppedOld = true;
    replacementPid = spawnRouter(candidateSource, port, stateFile, runtimeFile, logFile);
    await waitStatus(url, candidateSha256);
    if (sha256Bytes(fs.readFileSync(stateFile)) !== routeHash) throw new Error('ROUTER_ROUTE_DRIFT');
    const replacementRuntime = readJson(runtimeFile);
    verifyProcessIdentity(replacementRuntime.pid, port, stateFile);
    return { ok: true, changed: true, oldSha256, sourceSha256: candidateSha256, pid: Number(replacementRuntime.pid) };
  } catch (error) {
    if (replacementPid && alive(replacementPid)) {
      try { await stopProcess(replacementPid); } catch {}
    } else {
      try {
        const currentRuntime = readJson(runtimeFile);
        if (currentRuntime?.pid && alive(currentRuntime.pid) && currentRuntime.sourceSha256 !== oldSha256) await stopProcess(currentRuntime.pid);
      } catch {}
    }
    if (stoppedOld) {
      const rollbackPid = spawnRouter(oldSource, port, stateFile, runtimeFile, logFile);
      try {
        await waitStatus(url, oldSha256);
        if (sha256Bytes(fs.readFileSync(stateFile)) !== routeHash) throw new Error('ROUTER_ROLLBACK_ROUTE_DRIFT');
        const rollbackRuntime = readJson(runtimeFile);
        verifyProcessIdentity(rollbackRuntime.pid, port, stateFile);
      } catch (rollbackError) {
        if (alive(rollbackPid)) { try { await stopProcess(rollbackPid); } catch {} }
        throw new Error('ROUTER_BOOTSTRAP_ROLLBACK_FAIL:' + rollbackError.message);
      }
    }
    throw new Error('ROUTER_BOOTSTRAP_FAIL:' + error.message);
  }
}
function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!value) throw new Error('ROUTER_BOOTSTRAP_ARGUMENT');
    if (key === '--url') out.url = value;
    else if (key === '--state') out.stateFile = value;
    else if (key === '--runtime') out.runtimeFile = value;
    else if (key === '--candidate-source') out.candidateSource = value;
    else if (key === '--log') out.logFile = value;
    else throw new Error('ROUTER_BOOTSTRAP_ARGUMENT');
  }
  if (!out.url || !out.stateFile || !out.runtimeFile || !out.candidateSource || !out.logFile) throw new Error('ROUTER_BOOTSTRAP_ARGUMENT');
  return out;
}
const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invoked === import.meta.url) {
  try { console.log(JSON.stringify(await ensureRouterSource(parse(process.argv.slice(2))))); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
