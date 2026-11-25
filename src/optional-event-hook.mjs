// Optional, owner-installed, process-isolated event relay; not a specialty integration.
// No project data, arguments, credentials, outputs, or permission decisions are forwarded.
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomUUID as nodeRandomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

const TOOLS = new Set([
  'workflow_create','workflow_run_start','workflow_run_tick','workflow_checkpoint',
  'workflow_note','workflow_needs_chat','workflow_resume','workflow_reconcile',
  'workflow_finalize','workflow_run_resolve','operation_start','operation_result'
]);

function safePath(file, platform) {
  if (typeof file !== 'string' || file.length === 0 || file.length > 1024 || /[\x00-\x1f]/.test(file)) return false;
  const p = platform === 'win32' ? path.win32 : path.posix;
  return (platform === 'linux' || platform === 'darwin' || platform === 'win32')
    && p.isAbsolute(file) && p.extname(file).toLowerCase() === '.mjs'
    && (platform !== 'win32' || /^[A-Za-z]:[\\/]/.test(file));
}

function checkPinnedScript(file, digest, stat = lstatSync, read = readFileSync) {
  if (!/^[a-f0-9]{64}$/.test(digest)) return false;
  try {
    const info = stat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > 1024 * 1024) return false;
    return createHash('sha256').update(read(file)).digest('hex') === digest;
  } catch { return false; }
}

function safeEnvironment(env) {
  const out = {};
  for (const name of ['PATH', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA',
    'XDG_RUNTIME_DIR', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG']) {
    if (typeof env[name] === 'string') out[name] = env[name];
  }
  return out;
}

/**
 * Generic observer only. The separately installed, SHA-pinned .mjs script
 * runs as a child of the *current* Node runtime, never in Commander's process.
 * Installing the script does not grant any new Commander tool authority.
 */
export function createOptionalEventHook(config = {}, deps = {}) {
  const enabled = config?.enabled === true;
  const extensionId = typeof config?.extensionId === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(config.extensionId)
    ? config.extensionId : null;
  const script = config?.adapterPath;
  const sha = typeof config?.adapterSha256 === 'string' ? config.adapterSha256.toLowerCase() : '';
  const platform = deps.platform ?? process.platform;
  const spawn = deps.spawn ?? nodeSpawn;
  const stat = deps.stat ?? lstatSync;
  const read = deps.read ?? readFileSync;
  const env = deps.env ?? process.env;
  const execPath = deps.execPath ?? process.execPath;
  const uuid = deps.randomUUID ?? nodeRandomUUID;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const allowedPath = safePath(script, platform);
  const ready = () => enabled && !!extensionId && allowedPath && checkPinnedScript(script, sha, stat, read);
  const sessionId = uuid();
  let inFlight = false, attempts = 0, relayProcessExitedZero = 0, dropped = 0;
  function emitTool(name, outcome = {}) {
    if (!TOOLS.has(name) || !ready()) return false;
    if (inFlight) { dropped++; return false; }
    inFlight = true;
    attempts++;
    let child, timer, settled = false;
    const settle = code => {
      if (settled) return;
      settled = true;
      inFlight = false;
      if (timer) clearTimeout(timer);
      if (code === 0) relayProcessExitedZero++;
    };
    try {
      child = spawn(execPath, [script], {
        cwd: p.parse(script).root,
        shell: false, windowsHide: true,
        stdio: ['pipe', 'ignore', 'ignore'], env: safeEnvironment(env)
      });
      child.once('error', () => settle(-1));
      child.once('close', code => settle(code));
      child.stdin?.on?.('error', () => settle(-1));
      timer = setTimeout(() => { if (!settled) {
        try { child.kill(); } catch {}
        settle(-1);
      } }, 2000);
      timer.unref?.();
      child.stdin?.end?.(JSON.stringify({
        schemaVersion: 1, kind: 'tool_outcome', extensionId,
        tool: name, failed: outcome?.failed === true, sessionId
      }) + '\n');
      return true;
    } catch { settle(-1); return false; }
  }
  return Object.freeze({
    emitTool,
    status: () => ({
      enabled, ready: !!ready(), extensionId,
      attempts, relayProcessExitedZero, dropped, inFlight, deliveryConfirmed: false
    })
  });
}
