import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export function createWindowsGuiNativeAdapter({
  projectRoot,
  powershell = 'pwsh.exe',
  parentPid = process.pid,
  spawnImpl = spawn,
  approvalTimeoutMs = 70_000,
  requestTimeoutMs = 8_000
} = {}) {
  if (process.platform !== 'win32') throw new Error('GUI_WINDOWS_ONLY');
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    throw new TypeError('GUI_NATIVE_PROJECT_ROOT_REQUIRED');
  }
  const scriptPath = path.join(projectRoot, 'tools', 'gui-takeover.ps1');
  let child = null;
  let lines = null;
  let startupPromise = null;
  let pollTimer = null;
  let polling = false;
  let closed = false;
  let stderr = '';
  const pending = new Map();
  const subscribers = new Set();

  function rejectAll(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function failChild(error) {
    closed = true;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    rejectAll(error);
    for (const callback of subscribers) {
      try { callback('AGENT_DISCONNECTED'); } catch {}
    }
    subscribers.clear();
  }

  async function ensureStarted() {
    if (closed) throw new Error('GUI_NATIVE_PROVIDER_CLOSED');
    if (startupPromise) return startupPromise;
    startupPromise = new Promise((resolve, reject) => {
      const proc = spawnImpl(powershell, [
        '-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden',
        '-File',scriptPath,'-Server','-ParentPid',String(parentPid)
      ], {
        cwd:projectRoot,
        windowsHide:true,
        shell:false,
        stdio:['pipe','pipe','pipe']
      });
      child = proc;
      let firstLine = true;
      const startupTimer = setTimeout(() => {
        if (firstLine) reject(new Error('GUI_NATIVE_PROVIDER_START_TIMEOUT'));
      }, 10_000);
      lines = createInterface({input:proc.stdout,crlfDelay:Infinity});
      lines.on('line', line => {
        if (!line || line.length > 32_768) {
          failChild(new Error('GUI_NATIVE_PROVIDER_PROTOCOL_INVALID'));
          return;
        }
        let message;
        try { message = JSON.parse(line); }
        catch {
          failChild(new Error('GUI_NATIVE_PROVIDER_PROTOCOL_INVALID'));
          return;
        }
        if (firstLine) {
          firstLine = false;
          clearTimeout(startupTimer);
          if (message.ready !== true) {
            reject(new Error('GUI_NATIVE_PROVIDER_NOT_READY'));
            return;
          }
          resolve(message);
          startEventPolling();
          return;
        }
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.ok === true) entry.resolve(message.result);
        else entry.reject(new Error(message.error || 'GUI_NATIVE_PROVIDER_REQUEST_FAILED'));
      });
      proc.stderr.on('data', chunk => {
        stderr = (stderr + chunk.toString('utf8')).slice(-4096);
      });
      proc.once('error', error => {
        clearTimeout(startupTimer);
        reject(error);
        failChild(error);
      });
      proc.once('close', (code, signal) => {
        clearTimeout(startupTimer);
        const error = new Error('GUI_NATIVE_PROVIDER_EXITED');
        error.code = code;
        error.signal = signal;
        error.stderr = stderr;
        if (firstLine) reject(error);
        failChild(error);
      });
    }).catch(error => {
      startupPromise = null;
      throw error;
    });
    return startupPromise;
  }

  async function call(action, args = {}, timeoutMs = requestTimeoutMs) {
    await ensureStarted();
    if (closed || !child?.stdin?.writable) throw new Error('GUI_NATIVE_PROVIDER_DISCONNECTED');
    const id = randomUUID();
    const request = JSON.stringify({id,action,...args});
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('GUI_NATIVE_PROVIDER_REQUEST_TIMEOUT'));
      }, timeoutMs);
      pending.set(id,{resolve,reject,timer});
      child.stdin.write(request + '\n', error => {
        if (!error) return;
        const entry = pending.get(id);
        if (entry) {
          pending.delete(id);
          clearTimeout(entry.timer);
          reject(error);
        }
      });
    });
  }

  function startEventPolling() {
    if (pollTimer || subscribers.size === 0) return;
    pollTimer = setInterval(async () => {
      if (polling || closed || subscribers.size === 0) return;
      polling = true;
      try {
        const result = await call('events',{},requestTimeoutMs);
        for (const raw of result.events ?? []) {
          const event = ({
            OS_SECURE_ATTENTION:'OS_SECURE_ATTENTION',
            SESSION_DESKTOP_LOST:'OS_SECURE_ATTENTION',
            LEASE_EXPIRED:'LEASE_EXPIRED',
            OWNER_RELEASE:'OWNER_REVOKED',
            AGENT_DISCONNECTED:'AGENT_DISCONNECTED',
            AGENT_STOP:'AGENT_PROCESS_EXITED',
            INPUT_RELEASE_UNCONFIRMED:'AGENT_PROCESS_EXITED'
          })[raw] || raw;
          for (const callback of subscribers) {
            try { callback(event); } catch {}
          }
        }
      } catch {
        // Process close/error emits AGENT_DISCONNECTED and revokes the lease.
      } finally {
        polling = false;
      }
    },250);
    pollTimer.unref?.();
  }

  const adapter = {
    async describeSession() {
      const result = await call('describeSession');
      return result.descriptor;
    },
    async getPhysicalActivityEvidence() {
      const result = await call('activity');
      return result.activity;
    },
    async requestOwnerApproval({timeoutMs = 60_000} = {}) {
      const result = await call('approval',{timeoutMs},Math.max(approvalTimeoutMs,timeoutMs+5000));
      return result.approval;
    },
    async acquireProtection({ttlSeconds = 60} = {}) {
      return call('acquire',{ttlMs:ttlSeconds*1000},requestTimeoutMs);
    },
    async releaseProtection({leaseId,reason} = {}) {
      return call('release',{leaseId,reason},requestTimeoutMs);
    },
    async invokeInput(request = {}) {
      return call('input',{input:request},15_000);
    },
    subscribeEmergency(callback) {
      if (typeof callback !== 'function') throw new TypeError('GUI_EMERGENCY_CALLBACK_REQUIRED');
      subscribers.add(callback);
      if (child) startEventPolling();
      return () => {
        subscribers.delete(callback);
        if (subscribers.size === 0 && pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      };
    },
    async status() { return call('status'); },
    async close() {
      if (closed) return;
      try { await call('stop',{},requestTimeoutMs); } catch {}
      closed = true;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      try { lines?.close(); } catch {}
      try { child?.stdin?.end(); } catch {}
      try { child?.kill(); } catch {}
      rejectAll(new Error('GUI_NATIVE_PROVIDER_CLOSED'));
    }
  };

  return adapter;
}
