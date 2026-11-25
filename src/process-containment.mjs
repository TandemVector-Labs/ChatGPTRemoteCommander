import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminateProcessTree } from './platform.mjs';

const trustedProofs = new WeakSet();
// A caller-supplied timeout must never reach a native helper or JS timer as
// NaN, Infinity, a truncated uint32, or an effectively unbounded duration.
const MAX_CONTAINED_EXECUTION_MS = 3_600_000;
const MAX_CONTAINED_HELPER_MS = MAX_CONTAINED_EXECUTION_MS + 12_000;
function requireContainedTimeout(timeoutMs, maximum) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > maximum)
    throw commandError('PROCESS_CONTAINMENT_TIMEOUT_INVALID');
  return timeoutMs;
}
const BINDING_FIELDS = Object.freeze([
  'workflowId', 'stepId', 'operationId', 'rootFingerprint', 'revision', 'leaseId', 'fencingToken'
]);

function proofPayload(proof) {
  return {
    schema: 1,
    workflowId: proof.workflowId,
    stepId: proof.stepId,
    operationId: proof.operationId,
    rootFingerprint: proof.rootFingerprint,
    revision: proof.revision,
    leaseId: proof.leaseId,
    fencingToken: proof.fencingToken,
    provider: proof.provider,
    runId: proof.runId,
    activeProcesses: proof.activeProcesses,
    verified: proof.verified,
    outcome: proof.outcome,
    cleanupRequired: proof.cleanupRequired,
    completedAt: proof.completedAt
  };
}

function digestProof(proof) {
  return createHash('sha256').update(JSON.stringify(proofPayload(proof))).digest('hex');
}

function validBinding(binding) {
  return !!binding
    && typeof binding.workflowId === 'string' && binding.workflowId.length > 0
    && typeof binding.stepId === 'string' && binding.stepId.length > 0
    && typeof binding.operationId === 'string' && binding.operationId.length > 0
    && /^[a-f0-9]{64}$/.test(binding.rootFingerprint ?? '')
    && Number.isSafeInteger(binding.revision) && binding.revision >= 0
    && /^[a-f0-9]{64}$/.test(binding.leaseId ?? '')
    && Number.isSafeInteger(binding.fencingToken) && binding.fencingToken > 0;
}

function issueTrustedProcessCessationProof(binding, observation) {
  if (!validBinding(binding)) throw new Error('PROCESS_CESSATION_BINDING_INVALID');
  if (!observation || observation.verified !== true || observation.activeProcesses !== 0
    || typeof observation.provider !== 'string' || !observation.provider
    || typeof observation.runId !== 'string' || observation.runId !== binding.operationId
    || typeof observation.outcome !== 'string' || !observation.outcome
    || typeof observation.completedAt !== 'string' || !Number.isFinite(Date.parse(observation.completedAt))) {
    throw new Error('PROCESS_CESSATION_OBSERVATION_INVALID');
  }
  const proof = Object.freeze({
    schema: 1,
    ...Object.fromEntries(BINDING_FIELDS.map(key => [key, binding[key]])),
    provider: observation.provider,
    runId: observation.runId,
    activeProcesses: 0,
    verified: true,
    outcome: observation.outcome,
    cleanupRequired: observation.cleanupRequired === true,
    completedAt: observation.completedAt,
    proofDigest: ''
  });
  const signed = Object.freeze({ ...proof, proofDigest: digestProof(proof) });
  trustedProofs.add(signed);
  return signed;
}

export function isTrustedProcessCessationProof(proof, expectedBinding) {
  if (!proof || typeof proof !== 'object' || !trustedProofs.has(proof) || !validBinding(expectedBinding)) return false;
  if (proof.schema !== 1 || proof.verified !== true || proof.activeProcesses !== 0
    || proof.runId !== expectedBinding.operationId || proof.proofDigest !== digestProof(proof)) return false;
  return BINDING_FIELDS.every(key => proof[key] === expectedBinding[key]);
}

export function serializeProcessCessationProof(proof) {
  if (!proof || typeof proof !== 'object' || !trustedProofs.has(proof)
    || proof.proofDigest !== digestProof(proof)) return null;
  return { ...proof };
}
// Durable receipts are accepted only after the WorkflowStore has verified its hash-chained state.
// This checks integrity and the full operation binding; proofDigest is not a public-key signature.
export function isSerializedProcessCessationProof(proof, expectedBinding) {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof) || !validBinding(expectedBinding)) return false;
  const allowed = new Set(['schema', ...BINDING_FIELDS, 'provider', 'runId', 'activeProcesses',
    'verified', 'outcome', 'cleanupRequired', 'completedAt', 'proofDigest']);
  const keys = Object.keys(proof);
  if (keys.length !== allowed.size || keys.some(key => !allowed.has(key))) return false;
  if (proof.schema !== 1 || proof.verified !== true || proof.activeProcesses !== 0
    || typeof proof.provider !== 'string' || !proof.provider
    || typeof proof.runId !== 'string' || proof.runId !== expectedBinding.operationId
    || typeof proof.outcome !== 'string' || !proof.outcome
    || typeof proof.cleanupRequired !== 'boolean'
    || typeof proof.completedAt !== 'string' || !Number.isFinite(Date.parse(proof.completedAt))
    || !/^[a-f0-9]{64}$/.test(proof.proofDigest ?? '')
    || proof.proofDigest !== digestProof(proof)) return false;
  return BINDING_FIELDS.every(key => proof[key] === expectedBinding[key]);
}

function captureProcess(file, args, {
  cwd,
  env,
  timeoutMs = 30000,
  outputLimit = 32768,
  onTimeout = null
} = {}) {
  // Check again at the common timer sink: internal systemctl/pwsh calls must
  // remain bounded independently of the public runContainedProjectCommand API.
  requireContainedTimeout(timeoutMs, MAX_CONTAINED_HELPER_MS);
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        env,
        windowsHide: true,
        shell: false,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false, spawnError: error });
      return;
    }
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let spawnError = null;
    const collect = (current, chunk) => {
      const value = chunk.toString('utf8');
      if (current.length >= outputLimit) { truncated = true; return current; }
      if (current.length + value.length > outputLimit) truncated = true;
      return current + value.slice(0, Math.max(0, outputLimit - current.length));
    };
    child.stdout?.on('data', chunk => { stdout = collect(stdout, chunk); });
    child.stderr?.on('data', chunk => { stderr = collect(stderr, chunk); });
    child.once('error', error => { spawnError = error; });
    const timer = setTimeout(() => {
      timedOut = true;
      Promise.resolve(onTimeout?.(child)).catch(() => {
        try { if (child.pid) terminateProcessTree(child.pid, { signal: 'SIGKILL' }); } catch {}
      });
    }, timeoutMs);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, truncated, timedOut, spawnError });
    });
  });
}

function parseProperties(text) {
  const values = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0) values[line.slice(0, at)] = line.slice(at + 1);
  }
  return values;
}

async function cgroupActiveCount(controlGroup) {
  if (!controlGroup) return 0;
  if (typeof controlGroup !== 'string' || !controlGroup.startsWith('/')) return null;
  const base = '/sys/fs/cgroup';
  const target = path.resolve(base, controlGroup.slice(1));
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  try {
    const raw = await readFile(path.join(target, 'cgroup.procs'), 'utf8');
    return raw.trim() ? raw.trim().split(/\s+/).length : 0;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    return null;
  }
}

function systemdEnvironment(env) {
  const lines = [];
  for (const [key, raw] of Object.entries(env ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (raw === undefined || raw === null) continue;
    const value = String(raw);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\0\r\n]/.test(value)) {
      throw Object.assign(new Error('PROCESS_CONTAINMENT_ENV_INVALID'), { workflowCode: 'PROCESS_CONTAINMENT_ENV_INVALID' });
    }
    lines.push(key + '="' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"');
  }
  return lines.join('\n') + '\n';
}

function commandError(code, message = code) {
  return Object.assign(new Error(message), { workflowCode: code });
}

async function runLinuxContained({ program, args, cwd, timeoutMs, outputLimit, env, binding }) {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (!runtimeDir || !path.isAbsolute(runtimeDir)) throw commandError('PROCESS_CONTAINMENT_UNAVAILABLE');
  let runtimeInfo;
  try { runtimeInfo = await stat(runtimeDir); } catch { throw commandError('PROCESS_CONTAINMENT_UNAVAILABLE'); }
  if (!runtimeInfo.isDirectory() || (runtimeInfo.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && runtimeInfo.uid !== process.getuid())) {
    throw commandError('PROCESS_CONTAINMENT_RUNTIME_DIR_UNSAFE');
  }

  const tempDir = await mkdtemp(path.join(runtimeDir, 'rc-wf-env-'));
  let envFile = path.join(tempDir, 'environment.conf');
  try {
    await chmod(tempDir, 0o700);
    await writeFile(envFile, systemdEnvironment(env), { mode: 0o600, flag: 'wx' });
    const runId = binding.operationId;
    const unitName = 'rc-workflow-' + runId.replace(/[^A-Za-z0-9]/g, '') + '.service';
    const systemdArgs = [
      '--user', '--service-type=exec', '--pipe', '--wait', '--quiet',
      '--unit=' + unitName,
      '--property=ExitType=cgroup',
      '--property=KillMode=control-group',
      '--property=RuntimeMaxSec=' + timeoutMs + 'ms',
      '--property=TimeoutStopSec=2000ms',
      '--property=CollectMode=inactive',
      '--property=EnvironmentFile=' + envFile,
      '--working-directory=' + cwd,
      '--', program, ...args
    ];
    const run = await captureProcess('systemd-run', systemdArgs, {
      cwd,
      env: process.env,
      timeoutMs: timeoutMs + 12000,
      outputLimit,
      onTimeout: async child => {
        await captureProcess('systemctl', ['--user', 'stop', unitName], {
          cwd, env: process.env, timeoutMs: 5000, outputLimit: 4096
        });
        if (child.pid) terminateProcessTree(child.pid, { signal: 'SIGKILL' });
      }
    });
    if (run.spawnError) throw commandError('PROCESS_CONTAINMENT_UNAVAILABLE', 'systemd-run unavailable: ' + run.spawnError.message);

    const status = await captureProcess('systemctl', [
      '--user', 'show', unitName,
      '-p', 'LoadState', '-p', 'ActiveState', '-p', 'SubState',
      '-p', 'Result', '-p', 'ControlGroup', '-p', 'ExecMainStatus'
    ], { cwd, env: process.env, timeoutMs: 5000, outputLimit: 8192 });
    const props = parseProperties(status.stdout);
    let activeProcesses = null;
    if (props.LoadState === 'not-found') activeProcesses = 0;
    else if (props.ControlGroup) activeProcesses = await cgroupActiveCount(props.ControlGroup);
    else if (['inactive', 'failed'].includes(props.ActiveState)) activeProcesses = 0;

    const resultKind = props.Result ?? '';
    const stateInactive = props.LoadState === 'not-found'
      || (props.LoadState === 'loaded' && ['inactive', 'failed'].includes(props.ActiveState));
    const resultKnown = ['success', 'exit-code', 'timeout', 'signal', 'watchdog'].includes(resultKind);
    const runCompleted = !run.spawnError && Number.isSafeInteger(run.code);
    const verified = !status.spawnError && !status.timedOut && status.code === 0 && stateInactive
      && ((props.LoadState === 'not-found' && runCompleted)
        || (props.LoadState === 'loaded' && resultKnown && activeProcesses === 0));
    const timedOut = resultKind === 'timeout' || run.timedOut;
    const completedAt = new Date().toISOString();
    const proof = verified ? issueTrustedProcessCessationProof(binding, {
      provider: 'systemd-service-exit-type-cgroup',
      runId,
      activeProcesses: 0,
      verified: true,
      outcome: resultKind || (run.code === 0 ? 'success' : 'unknown'),
      cleanupRequired: timedOut,
      completedAt
    }) : null;

    if (props.LoadState === 'loaded' && props.ActiveState === 'failed') {
      await captureProcess('systemctl', ['--user', 'reset-failed', unitName], {
        cwd, env: process.env, timeoutMs: 3000, outputLimit: 2048
      });
    }

    return {
      program, args, cwd, timeoutMs, timedOut,
      exitCode: run.code, signal: run.signal, stdout: run.stdout, stderr: run.stderr,
      truncated: run.truncated,
      isError: !verified,
      containment: {
        provider: 'systemd-service-exit-type-cgroup', runId, unitName,
        status: resultKind || props.ActiveState || props.LoadState || 'unknown',
        activeProcesses, verified, completedAt
      },
      ...(proof ? { processCessationProof: proof } : {})
    };
  } finally {
    try { await rm(tempDir, { recursive: true, force: true }); } catch {}
  }
}

function parseWindowsReport(raw, runId) {
  const lines = String(raw ?? '').split(/\r?\n/);
  let report = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const prefix = 'QUALIFICATION_JOB_RESULT ';
    if (!lines[i].startsWith(prefix)) continue;
    try {
      const candidate = JSON.parse(lines[i].slice(prefix.length));
      if (candidate?.runId === runId) { report = candidate; lines.splice(i, 1); }
    } catch {}
    break;
  }
  return { report, output: lines.join('\n') };
}

async function runWindowsContained({ program, args, cwd, timeoutMs, outputLimit, env, binding }) {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const scriptPath = path.resolve(moduleDirectory, '..', 'tools', 'run-owned-process-tree-windows.ps1');
  try { await stat(scriptPath); } catch { throw commandError('PROCESS_CONTAINMENT_UNAVAILABLE', 'Windows Job Object runner missing'); }
  const runId = binding.operationId;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'rc-wf-job-'));
  const reportPath = path.join(tempDir, 'report.json');
  try {
    const helperArgs = [
      '-NoProfile', '-NonInteractive', '-File', scriptPath,
      '-Program', program,
      '-WorkingDirectory', cwd,
      '-ArgumentsJson', JSON.stringify(args),
      '-RunId', runId,
      '-TimeoutSeconds', String(Math.max(1, Math.ceil(timeoutMs / 1000))),
      '-DrainGraceMs', '2000',
      '-ReportPath', reportPath
    ];
    const run = await captureProcess('pwsh.exe', helperArgs, {
      cwd, env, timeoutMs: timeoutMs + 12000, outputLimit,
      onTimeout: child => { if (child.pid) terminateProcessTree(child.pid, { signal: 'SIGKILL' }); }
    });
    if (run.spawnError) throw commandError('PROCESS_CONTAINMENT_UNAVAILABLE', 'PowerShell 7 Job Object runner unavailable: ' + run.spawnError.message);
    let report = null;
    try { report = JSON.parse(await readFile(reportPath, 'utf8')); } catch {}
    const parsed = parseWindowsReport(run.stdout, runId);
    if (!report && parsed.report) report = parsed.report;
    const output = report ? parsed.output : run.stdout;
    const verified = run.code !== null && report?.runId === runId
      && ['PASS','FAIL','FAIL_CLEANED','DESCENDANT_LEAK_CLEANED','TIMEOUT_CLEANED'].includes(report.status)
      && report.cleanupVerified === true && report.activeAfterCleanup === 0
      && typeof report.completedAt === 'string';
    const timedOut = report?.timedOut === true || report?.status === 'TIMEOUT_CLEANED' || run.timedOut;
    const completedAt = verified ? report.completedAt : new Date().toISOString();
    const proof = verified ? issueTrustedProcessCessationProof(binding, {
      provider: 'windows-job-object',
      runId,
      activeProcesses: 0,
      verified: true,
      outcome: report.status,
      cleanupRequired: report.cleanupRequired === true,
      completedAt
    }) : null;
    return {
      program, args, cwd, timeoutMs, timedOut,
      exitCode: run.code, signal: run.signal, stdout: output, stderr: run.stderr,
      truncated: run.truncated,
      isError: !verified,
      containment: {
        provider: 'windows-job-object', runId,
        status: report?.status ?? 'RUNNER_ERROR',
        activeBeforeCleanup: Number.isSafeInteger(report?.activeBeforeCleanup) ? report.activeBeforeCleanup : null,
        activeAfterCleanup: Number.isSafeInteger(report?.activeAfterCleanup) ? report.activeAfterCleanup : null,
        cleanupRequired: report?.cleanupRequired === true,
        cleanupVerified: report?.cleanupVerified === true,
        verified, completedAt
      },
      ...(proof ? { processCessationProof: proof } : {})
    };
  } finally {
    try { await rm(tempDir, { recursive: true, force: true }); } catch {}
  }
}

export async function processContainmentAvailable() {
  if (process.platform === 'linux') {
    try {
      const runtimeDir = process.env.XDG_RUNTIME_DIR;
      if (!runtimeDir || !path.isAbsolute(runtimeDir)) return false;
      const runtimeInfo = await stat(runtimeDir);
      if (!runtimeInfo.isDirectory() || (runtimeInfo.mode & 0o077) !== 0
        || (typeof process.getuid === 'function' && runtimeInfo.uid !== process.getuid())) return false;
      const controllers = await readFile('/sys/fs/cgroup/cgroup.controllers', 'utf8');
      if (!controllers.trim()) return false;
      const [systemd, manager] = await Promise.all([
        captureProcess('systemd-run', ['--version'], { cwd:runtimeDir, env:process.env, timeoutMs:3000, outputLimit:4096 }),
        captureProcess('systemctl', ['--user','show-environment'], { cwd:runtimeDir, env:process.env, timeoutMs:3000, outputLimit:4096 })
      ]);
  const version = systemd.stdout.match(/^systemd\s+(\d+)/m);
      return systemd.code === 0 && manager.code === 0 && !!version && Number(version[1]) >= 250;
    } catch { return false; }
  }
  if (process.platform === 'win32') {
    const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'run-owned-process-tree-windows.ps1');
    try {
      await stat(scriptPath);
      const version = await captureProcess('pwsh.exe', ['-NoProfile','-NonInteractive','-Command','$PSVersionTable.PSVersion.Major'], {
        cwd:process.cwd(), env:process.env, timeoutMs:3000, outputLimit:4096
      });
      return version.code === 0 && Number(version.stdout.trim()) >= 7;
    } catch { return false; }
  }
  return false;
}

export async function runContainedProjectCommand({ program, args, cwd, timeoutMs, outputLimit, env, binding }) {
  if (!validBinding(binding)) throw commandError('PROCESS_CONTAINMENT_BINDING_REQUIRED');
  // Deny malformed timeouts before probing a provider or spawning anything.
  requireContainedTimeout(timeoutMs, MAX_CONTAINED_EXECUTION_MS);
  if (!(await processContainmentAvailable())) throw commandError('PROCESS_CONTAINMENT_UNAVAILABLE');
  if (process.platform === 'linux') {
    return runLinuxContained({ program, args, cwd, timeoutMs, outputLimit, env, binding });
  }
  if (process.platform === 'win32') {
    return runWindowsContained({ program, args, cwd, timeoutMs, outputLimit, env, binding });
  }
  throw commandError('PROCESS_CONTAINMENT_UNAVAILABLE');
}
