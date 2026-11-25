import os from 'node:os';
import path from 'node:path';
import { mkdir, lstat, chmod, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const MAX_BYTES = 64 * 1024;

export function defaultBrowserCompanionRoot({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA;
    return local ? path.win32.join(local, 'ChatGPTRemoteCommander', 'browser-companion') : '';
  }
  const state = env.XDG_STATE_HOME;
  return state ? path.posix.join(state, 'chatgpt-remote-commander', 'browser-companion')
    : path.posix.join(home, '.local', 'state', 'chatgpt-remote-commander', 'browser-companion');
}

async function provePrivateRoot(root, { platform = process.platform } = {}) {
  const flavor = platform === 'win32' ? path.win32 : path.posix;
  if (!root || !flavor.isAbsolute(root)) throw new Error('BROWSER_COMPANION_ROOT_INVALID');
  if (platform === 'win32') {
    // A new user-local installation may have no browser companion directory.
    // Preserve the existing root validation: symbolic links still fail closed.
    await mkdir(root, { recursive: true });
  } else {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
  }
  let stat;
  try { stat = await lstat(root); } catch { throw new Error('BROWSER_COMPANION_ROOT_MISSING'); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('BROWSER_COMPANION_ROOT_UNSAFE');
  if (platform !== 'win32') {
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('BROWSER_COMPANION_ROOT_OWNER_MISMATCH');
    if ((stat.mode & 0o077) !== 0) throw new Error('BROWSER_COMPANION_ROOT_NOT_PRIVATE');
  }
  return root;
}

export function sanitizeMonitorSnapshot(input, now = Date.now()) {
  const text = value => typeof value === 'string' ? value.slice(0, 160) : '';
  const optionalText = value => {
    const normalized = text(value);
    return normalized ? normalized : null;
  };
  const truth = value => value === true;
  const cap = input?.gui?.capabilities ?? {};
  const guiPolicy = input?.gui?.policy ?? {};
  const capability = (name, policyName) =>
    Object.prototype.hasOwnProperty.call(cap, name) ? truth(cap[name]) : truth(guiPolicy[policyName]);
  const extensions = Array.isArray(input?.extensions?.items) ? input.extensions.items.slice(0, 32).map(item => ({
    id: text(item?.id).slice(0, 64),
    version: text(item?.version).slice(0, 64)
  })).filter(item => item.id) : [];
  return {
    schema: 1,
    kind: 'COMMANDER_LIVE_MONITOR',
    observedAtEpochMs: now,
    expiresAtEpochMs: now + 10000,
    identity: {
      deviceName: text(input?.identity?.deviceName),
      profile: text(input?.identity?.profile),
      version: text(input?.identity?.version),
      configSha256: /^[a-f0-9]{64}$/.test(input?.identity?.configSha256 ?? '') ? input.identity.configSha256 : '',
      port: Number.isInteger(input?.identity?.port) ? input.identity.port : 0,
      platform: text(input?.identity?.platform)
    },
    gui: {
      enabled: truth(input?.gui?.enabled),
      available: truth(input?.gui?.available),
      uncertain: truth(input?.gui?.uncertain),
      backend: optionalText(input?.gui?.backend),
      sessionType: optionalText(input?.gui?.sessionType),
      reason: optionalText(input?.gui?.reason),
      capabilities: {
        screenshot: capability('screenshot', 'allowScreenshot'),
        mouse: capability('mouse', 'allowMouse'),
        keyboard: capability('keyboard', 'allowKeyboard'),
        focus: capability('focus', 'allowWindowFocus')
      }
    },
    browser: {
      enabled: truth(input?.browser?.enabled),
      available: truth(input?.browser?.available),
      uncertain: truth(input?.browser?.uncertain),
      backend: optionalText(input?.browser?.backend),
      reason: optionalText(input?.browser?.reason)
    },
    workflows: {
      enabled: truth(input?.workflows?.enabled),
      engineEnabled: truth(input?.workflows?.engineEnabled),
      runCount: Number.isInteger(input?.workflows?.runCount) ? Math.max(0, Math.min(input.workflows.runCount, 10000)) : 0
    },
    extensions: { count: extensions.length, items: extensions },
    operations: {
      active: Number.isInteger(input?.operations?.active) ? Math.max(0, input.operations.active) : 0,
      lockedKeys: Number.isInteger(input?.operations?.lockedKeys) ? Math.max(0, input.operations.lockedKeys) : 0
    }
  };
}

export async function writeBrowserCompanionMonitor(root, input, options = {}) {
  await provePrivateRoot(root, options);
  const snapshot = sanitizeMonitorSnapshot(input, options.now?.() ?? Date.now());
  const data = JSON.stringify(snapshot) + '\n';
  if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('BROWSER_COMPANION_SNAPSHOT_LIMIT');
  const flavor = (options.platform ?? process.platform) === 'win32' ? path.win32 : path.posix;
  const target = flavor.join(root, 'commander-monitor.json');
  const temporary = flavor.join(root, '.commander-monitor-' + process.pid + '-' + randomUUID() + '.tmp');
  try {
    await writeFile(temporary, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    if ((options.platform ?? process.platform) !== 'win32') await chmod(temporary, 0o600);
    await rename(temporary, target);
  } catch (error) {
    try { await unlink(temporary); } catch {}
    throw error;
  }
  return { target, bytes: Buffer.byteLength(data), observedAtEpochMs: snapshot.observedAtEpochMs };
}

export function startBrowserCompanionMonitor({ snapshot, root = defaultBrowserCompanionRoot(), intervalMs = 2000, onError = () => {} } = {}) {
  if (typeof snapshot !== 'function') throw new Error('BROWSER_COMPANION_SNAPSHOT_PROVIDER_REQUIRED');
  const state = { enabled: true, lastWriteAtEpochMs: 0, lastError: '' };
  let stopped = false, running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const value = await snapshot();
      const receipt = await writeBrowserCompanionMonitor(root, value);
      state.lastWriteAtEpochMs = receipt.observedAtEpochMs;
      state.lastError = '';
    } catch (error) {
      state.lastError = String(error?.code ?? error?.message ?? error).slice(0, 160);
      onError(state.lastError);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return {
    status: () => ({ ...state }),
    stop: () => { stopped = true; clearInterval(timer); state.enabled = false; }
  };
}
