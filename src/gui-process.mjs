import { spawn } from 'node:child_process';
import { guiError } from './gui-contract.mjs';

function parseGuiResult(bytes) {
  let value;
  try {
    value = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.ok !== 'boolean') throw new Error();
  } catch {
    throw guiError('GUI_HELPER_BAD_JSON');
  }
  if (value.ok !== true) {
    const safeCode = /^[A-Z][A-Z0-9_]{1,79}$/.test(value.error ?? '') ? value.error : 'GUI_NATIVE_FAILED';
    const failure = guiError(safeCode);
    // Only the fixed Windows helper can report a mutex denial before dispatch.
    // Exact closed schema: extra fields, naked errors and transport failures are unsafe.
    if (safeCode === 'GUI_NATIVE_BUSY' && value.ok === false &&
        value.error === 'GUI_NATIVE_BUSY' && value.submission === 'NOT_SUBMITTED' &&
        Object.getPrototypeOf(value) === Object.prototype &&
        Reflect.ownKeys(value).length === 3 &&
        ['ok','error','submission'].every(key => Object.hasOwn(value,key))) {
      failure.guiNotApplied = true;
      failure.guiWindowsMutexPreDispatch = true;
    }
    // Only the pinned Linux native guard may attest rejection before input dispatch.
    if (safeCode === 'GUI_FOREGROUND_OR_GEOMETRY_CHANGED' &&
        value.effect === 'NOT_APPLIED' && value.phase === 'PRE_DISPATCH_GUARD') {
      failure.guiNotApplied = true;
    }
    throw failure;
  }
  return value;
}

/** Execute only the fixed helper path, with JSON on stdin (never in process args).
 * Bounded buffers, one JSON result, cleanup on every termination path.
 * A failed input is NOT retried. Caller latches uncertain native outcomes.
 */
export function runGuiProcess(request, { file, args, timeoutMs = 15000, maxBytes = 7 * 1024 * 1024, env = process.env }) {
  return new Promise((resolve, reject) => {
    let child;
    let timer;
    let done = false;
    let outBytes = 0;
    let errBytes = 0;
    const chunks = [];
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) { child?.kill(); reject(error); } else resolve(value);
    };
    try { child = spawn(file, args, { windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false }); }
    catch { finish(guiError('GUI_HELPER_START_FAILED')); return; }
    child.once('error', () => finish(guiError('GUI_HELPER_START_FAILED')));
    child.stdin.once('error', () => finish(guiError('GUI_HELPER_STDIN_FAILED')));
    child.stdout.on('data', chunk => {
      if (done) return;
      outBytes += chunk.length;
      if (outBytes > maxBytes) finish(guiError('GUI_HELPER_OUTPUT_LIMIT')); else chunks.push(chunk);
    });
    child.stderr.on('data', chunk => {
      errBytes += chunk.length;
      if (errBytes > 16384) finish(guiError('GUI_HELPER_OUTPUT_LIMIT'));
      // Intentionally never forward raw stderr: it can contain screen titles or typed text.
    });
    child.once('close', code => {
      if (done) return;
      if (code !== 0) { finish(guiError('GUI_HELPER_EXIT_FAILED')); return; }
      try { finish(null, parseGuiResult(Buffer.concat(chunks))); }
      catch (error) { finish(error); }
    });
    timer = setTimeout(() => finish(guiError('GUI_HELPER_TIMEOUT')), timeoutMs);
    child.stdin.end(JSON.stringify(request), 'utf8');
  });
}

/** Persistent line-oriented helper client.
 * PowerShell/.NET GUI types are loaded once, then one bounded JSON request is sent per line.
 * There is never more than one in-flight request; the GUI controller already rejects concurrency.
 * Helper crashes/timeouts are fail-closed and the next read may start a fresh helper.
 */
export function createGuiProcessClient({
  file,
  args,
  timeoutMs = 15000,
  startupTimeoutMs = 15000,
  maxBytes = 7 * 1024 * 1024,
  env = process.env
}) {
  let child = null;
  let buffer = Buffer.alloc(0);
  let startup = null;
  let pending = null;
  let stderrBytes = 0;
  let intentionalClose = false;

  const clearPendingTimer = () => {
    if (pending?.timer) clearTimeout(pending.timer);
  };
  const clearStartupTimer = () => {
    if (startup?.timer) clearTimeout(startup.timer);
  };
  const killChild = () => {
    const c = child;
    child = null;
    if (c && c.exitCode === null && !c.killed) c.kill();
  };
  const fail = (code) => {
    const error = guiError(code);
    if (startup) {
      const s = startup;
      clearStartupTimer();
      startup = null;
      s.reject(error);
    }
    if (pending) {
      const p = pending;
      clearPendingTimer();
      pending = null;
      p.reject(error);
    }
    buffer = Buffer.alloc(0);
    killChild();
  };
  const completeLine = line => {
    let value;
    try { value = parseGuiResult(line); }
    catch (error) {
      if (error.guiNotApplied === true && pending && !startup) {
        // Forward the exact no-effect receipt; no helper retry or input replay.
        const p = pending;
        clearPendingTimer();
        pending = null;
        p.reject(error);
        return;
      }
      const code = error.guiCode ?? (error.message || 'GUI_HELPER_BAD_JSON');
      fail(code);
      return;
    }
    if (startup) {
      if (value.ready !== true || value.protocol !== 1) { fail('GUI_HELPER_BAD_JSON'); return; }
      const s = startup;
      clearStartupTimer();
      startup = null;
      s.resolve();
      return;
    }
    if (!pending) { fail('GUI_HELPER_BAD_JSON'); return; }
    const p = pending;
    clearPendingTimer();
    pending = null;
    p.resolve(value);
  };
  const consume = chunk => {
    if (!child) return;
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk);
    const limit = startup ? 65536 : pending ? maxBytes : 65536;
    if (buffer.length > limit && buffer.indexOf(0x0a) === -1) { fail('GUI_HELPER_OUTPUT_LIMIT'); return; }
    while (child) {
      const nl = buffer.indexOf(0x0a);
      if (nl < 0) break;
      if (nl > (startup ? 65536 : maxBytes)) { fail('GUI_HELPER_OUTPUT_LIMIT'); return; }
      let line = buffer.subarray(0, nl);
      buffer = buffer.subarray(nl + 1);
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
      if (!line.length) { fail('GUI_HELPER_BAD_JSON'); return; }
      completeLine(line);
    }
  };
  const start = () => {
    if (child && child.exitCode === null && !child.killed && !startup) return Promise.resolve();
    if (startup) return startup.promise;
    intentionalClose = false;
    buffer = Buffer.alloc(0);
    stderrBytes = 0;
    let spawned;
    try { spawned = spawn(file, args, { windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false }); }
    catch { return Promise.reject(guiError('GUI_HELPER_START_FAILED')); }
    child = spawned;
    let resolveStart;
    let rejectStart;
    const promise = new Promise((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
    startup = { promise, resolve: resolveStart, reject: rejectStart, timer: null };
    startup.timer = setTimeout(() => fail('GUI_HELPER_TIMEOUT'), startupTimeoutMs);
    spawned.once('error', () => fail('GUI_HELPER_START_FAILED'));
    spawned.stdin.on('error', () => fail('GUI_HELPER_STDIN_FAILED'));
    spawned.stdout.on('data', consume);
    spawned.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > 16384) fail('GUI_HELPER_OUTPUT_LIMIT');
      // Raw stderr is intentionally discarded.
    });
    spawned.once('close', code => {
      if (child !== spawned) return;
      child = null;
      buffer = Buffer.alloc(0);
      if (intentionalClose) return;
      if (startup || pending) fail(code === 0 ? 'GUI_HELPER_EXIT_FAILED' : 'GUI_HELPER_EXIT_FAILED');
    });
    return promise;
  };

  const invoke = async request => {
    if (pending) throw guiError('GUI_HELPER_BUSY');
    await start();
    if (!child || child.exitCode !== null || child.killed) throw guiError('GUI_HELPER_EXIT_FAILED');
    return new Promise((resolve, reject) => {
      pending = {
        resolve,
        reject,
        timer: setTimeout(() => fail('GUI_HELPER_TIMEOUT'), timeoutMs)
      };
      const line = JSON.stringify(request) + '\n';
      child.stdin.write(line, 'utf8', error => {
        if (error) fail('GUI_HELPER_STDIN_FAILED');
      });
    });
  };

  const close = () => {
    intentionalClose = true;
    if (startup) {
      const s = startup;
      clearStartupTimer();
      startup = null;
      s.reject(guiError('GUI_HELPER_EXIT_FAILED'));
    }
    if (pending) {
      const p = pending;
      clearPendingTimer();
      pending = null;
      p.reject(guiError('GUI_HELPER_EXIT_FAILED'));
    }
    buffer = Buffer.alloc(0);
    killChild();
  };

  return { invoke, close };
}
