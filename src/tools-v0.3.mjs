import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { synchronousCommandInput } from './retry-guard.mjs';
import { assertNoCodexDelegatingScript, assertNoCodexExecutable, codexLaunchAuthorized, commanderChildEnv } from './no-codex-policy.mjs';
import { appendFile, copyFile, mkdir, opendir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { terminateProcessTree } from './platform.mjs';
import { boundedCommandTimeout } from './command-timeout-limits.mjs';
import { runContainedProjectCommand } from './process-containment.mjs';
import { withPathLocks } from './locks.mjs';
import { guardFileWrite } from './file-write-guard.mjs';
import {
  psQuote,
  rootForPath,
  safeExistingPath,
  safeWritablePath,
  validateCommandArgs,
  validateProgram
} from './security-v0.3.mjs';
import { resolveExistingTarget, writeAnyFile } from './power-tools-v0.3.mjs';
import { hasEffectiveFullFilesystem } from './effective-power-mode.mjs';
import { assertEnumerationScope } from './filesystem-enumeration-guard.mjs';

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function legacyPowerFullFilesystem(ctx) {
  return hasEffectiveFullFilesystem(ctx.config, { accessStatus: ctx.accessStatus });
}

async function legacyExistingPath(ctx, userPath, base = ctx.roots[0]) {
  if (legacyPowerFullFilesystem(ctx)) return resolveExistingTarget(ctx, userPath, base);
  return safeExistingPath(userPath, ctx.roots, base);
}

let auditTail = Promise.resolve();

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(Math.trunc(parsed), maximum));
}

async function rotateAuditLog(ctx, nextBytes) {
  const maxBytes = boundedInteger(ctx.config.auditMaxBytes, 8 * 1024 * 1024, 64 * 1024, 1024 * 1024 * 1024);
  const keepFiles = boundedInteger(ctx.config.auditKeepFiles, 3, 1, 20);
  let currentBytes = 0;
  try { currentBytes = (await stat(ctx.auditLog)).size; }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (currentBytes === 0 || currentBytes + nextBytes <= maxBytes) {
    return { rotated: false, maxBytes, keepFiles };
  }

  await rm(`${ctx.auditLog}.${keepFiles}`, { force: true });
  for (let index = keepFiles - 1; index >= 1; index -= 1) {
    try { await rename(`${ctx.auditLog}.${index}`, `${ctx.auditLog}.${index + 1}`); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  try { await rename(ctx.auditLog, `${ctx.auditLog}.1`); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return { rotated: true, maxBytes, keepFiles };
}

export function audit(ctx, record) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n';
  const nextBytes = Buffer.byteLength(line, 'utf8');
  const operation = auditTail.then(async () => {
    await mkdir(path.dirname(ctx.auditLog), { recursive: true });
    await rotateAuditLog(ctx, nextBytes);
    await appendFile(ctx.auditLog, line, 'utf8');
  });
  auditTail = operation.catch(() => {});
  return operation;
}
async function walkDirectory(dir, depth, maxEntries, base, out) {
  if (out.length >= maxEntries) return;
  const directory = await opendir(dir, { bufferSize: 1 });
  for await (const entry of directory) {
    if (out.length >= maxEntries) break;
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full) || '.';
    out.push({ path: rel, type: entry.isDirectory() ? 'directory' : 'file' });
    if (entry.isDirectory() && depth > 0) {
      await walkDirectory(full, depth - 1, maxEntries, base, out);
    }
  }
}

export async function listDirectory(ctx, input) {
  const target = await legacyExistingPath(ctx, input.path ?? '.', ctx.roots[0]);
  const info = await stat(target);
  if (!info.isDirectory()) throw new Error('path is not a directory');
  const depth = Math.max(0, Math.min(Number(input.depth ?? 1), 4));
  assertEnumerationScope({ target, depth, operation: 'list_directory' });
  const maxEntries = Math.max(1, Math.min(Number(input.maxEntries ?? 200), 500));
  const entries = [];
  await walkDirectory(target, depth, maxEntries, target, entries);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  await audit(ctx, { action: 'list_directory', target, ok: true, count: entries.length });
  return { target, depth, truncated: entries.length >= maxEntries, entries };
}
export async function readText(ctx, input) {
  const fullFilesystem = legacyPowerFullFilesystem(ctx);
  const target = await legacyExistingPath(ctx, input.path, ctx.roots[0]);
  const info = await stat(target);
  if (!info.isFile()) throw new Error('path is not a file');
  const configuredMax = Number(fullFilesystem
    ? (ctx.config.powerMode?.maxFileBytes ?? ctx.config.maxReadBytes ?? 524288)
    : (ctx.config.maxReadBytes ?? 524288));
  if (info.size > configuredMax) throw new Error(`file exceeds maxReadBytes (${configuredMax})`);
  const buffer = await readFile(target);
  if (buffer.includes(0)) throw new Error('binary files are not supported by read_text');
  const paging = input.offset !== undefined || input.maxBytes !== undefined;
  const inlineMax = 512 * 1024;
  if (!paging && buffer.length > inlineMax) {
    throw new Error('SYNCHRONOUS_READ_REQUIRES_PAGING: file exceeds 512 KiB inline limit; use offset/maxBytes');
  }
  const offset = input.offset === undefined ? 0 : Number(input.offset);
  const maxBytes = input.maxBytes === undefined ? Math.min(buffer.length, inlineMax) : Number(input.maxBytes);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > buffer.length) throw new Error('offset must be a valid byte offset');
  if (paging && offset > 0 && offset < buffer.length && (buffer[offset] & 0xC0) === 0x80) throw new Error('UTF8_PAGE_OFFSET_UNSAFE');
  if (paging && (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024)) {
    throw new Error('maxBytes must be between 1 and 262144');
  }
  let end = paging ? Math.min(buffer.length, offset + maxBytes) : buffer.length;
  if (paging && end < buffer.length) {
    while (end > offset && (buffer[end] & 0xC0) === 0x80) end -= 1;
    if (end === offset) throw new Error('UTF8_PAGE_BOUNDARY_UNSAFE');
  }
  const page = buffer.subarray(offset, end);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(page);
  const result = {
    path: target,
    bytes: page.length,
    fileBytes: buffer.length,
    offset,
    nextOffset: end < buffer.length ? end : null,
    truncated: end < buffer.length,
    sha256: sha256(buffer),
    chunkSha256: sha256(page),
    text
  };
  await audit(ctx, { action: 'read_text', target, ok: true, bytes: page.length, fileBytes: buffer.length, offset,
    paged: paging, powerModeFullFilesystem: fullFilesystem });
  return result;
}
export async function writeText(ctx, input) {
  if (input.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.expectedSha256)) throw new Error('expectedSha256 must be a lowercase 64-hex SHA-256');
  if (typeof input.content !== 'string') throw new Error('content must be a string');
  const fullFilesystem = legacyPowerFullFilesystem(ctx);
  const bytes = Buffer.byteLength(input.content, 'utf8');
  const maxWriteBytes = Math.min(512 * 1024, Number(fullFilesystem
    ? (ctx.config.powerMode?.maxFileBytes ?? ctx.config.maxWriteBytes ?? 524288)
    : (ctx.config.maxWriteBytes ?? 524288)));
  if (bytes > maxWriteBytes) {
    throw new Error(`content exceeds maxWriteBytes (${maxWriteBytes})`);
  }
  const mode = input.mode === 'append' ? 'append' : 'overwrite';

  if (fullFilesystem) {
    const result = await writeAnyFile(ctx, {
      path: input.path,
      content: input.content,
      mode,
      expectedSha256: input.expectedSha256,
      encoding: 'utf8',
      createParents: false
    });
    const adapted = { ...result, mode };
    await audit(ctx, {
      action: 'write_text', target: adapted.path, ok: true, mode, bytes,
      backupPath: adapted.backupPath, powerModeFullFilesystem: true
    });
    return adapted;
  }

  const target = await safeWritablePath(input.path, ctx.roots, ctx.roots[0]);
  return withPathLocks([target], async () => {
    const snapshot = await guardFileWrite(target);
    let beforeHash = null;
    let backupPath = null;
    try {
      const before = await readFile(target);
      beforeHash = sha256(before);
      if (input.expectedSha256 && input.expectedSha256 !== beforeHash) {
        throw new Error('expectedSha256 does not match current file');
      }
      await guardFileWrite(target, snapshot);
      const root = rootForPath(target, ctx.roots);
      const rel = path.relative(root, target);
      const stamp = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
      backupPath = path.join(root, '.remote-commander-backups', stamp, rel);
      await mkdir(path.dirname(backupPath), { recursive: true });
      await copyFile(target, backupPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (input.expectedSha256 !== undefined) throw new Error('expectedSha256 precondition failed: target does not exist');
    }
    await guardFileWrite(target, snapshot);
    if (mode === 'append') await appendFile(target, input.content, 'utf8');
    else await writeFile(target, input.content, 'utf8');
    const after = await readFile(target);
    const result = { path: target, mode, bytes: after.length, beforeSha256: beforeHash, sha256: sha256(after), backupPath };
    await audit(ctx, { action: 'write_text', target, ok: true, mode, bytes, backupPath });
    return result;
  });
}
export async function prepareProjectCommand(ctx, input) {
  const fullFilesystem = legacyPowerFullFilesystem(ctx);
  const program = validateProgram(input.program, ctx.config.allowedPrograms);
  const cwd = await legacyExistingPath(ctx, input.cwd ?? '.', ctx.roots[0]);
  const allowCodex = codexLaunchAuthorized(ctx);
  assertNoCodexExecutable(program, { allowCodex });
  const info = await stat(cwd);
  if (!info.isDirectory()) throw new Error('cwd is not a directory');
  const args = validateCommandArgs(program, input.args ?? [], cwd, ctx.roots, { fullFilesystem });
  await assertNoCodexDelegatingScript(program, args, cwd, { allowCodex });
  const timeoutMs = boundedCommandTimeout(input.timeoutMs, ctx.config.maxCommandMs ?? 300000);
  return { file: program, args, cwd, timeoutMs, outputLimit: 262144, fullFilesystem };
}
export function v102WindowsJobReceipt(stderrTail, runnerExitCode) {
  const unverified = () => { throw new Error('WINDOWS_JOB_RUNNER_COMPLETION_UNVERIFIED'); };
  if (typeof stderrTail !== 'string') unverified();
  // The native runner emits the final receipt after its child exits. Child
  // stderr may contain arbitrary lookalike markers; accept only the last full
  // marker, at the end of the stream, and reconcile it to the runner exit.
  const matches = [...stderrTail.matchAll(/(?:^|\n)RC_JOB_RESULT_JSON:(\{[^\r\n]*\})(?=\r?\n|$)/g)];
  const last = matches.at(-1);
  if (!last || stderrTail.slice(last.index + last[0].length).trim() !== '') unverified();
  let receipt;
  try { receipt = JSON.parse(last[1]); } catch { unverified(); }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
      || receipt.termination !== 'job-object'
      || typeof receipt.timedOut !== 'boolean'
      || !Number.isSafeInteger(receipt.processId) || receipt.processId <= 0
      || !Number.isSafeInteger(runnerExitCode) || runnerExitCode < 0 || runnerExitCode > 255) {
    unverified();
  }
  if (receipt.timedOut) {
    if (runnerExitCode !== 124 || Object.hasOwn(receipt, 'exitCode')) unverified();
  } else {
    if (!Number.isSafeInteger(receipt.exitCode) || receipt.exitCode < 0
        || receipt.exitCode > 0xFFFFFFFF
        || runnerExitCode !== (receipt.exitCode > 255 ? 1 : receipt.exitCode)) unverified();
  }
  return receipt;
}

export async function runProjectCommand(ctx, input) {
  const prepared = await prepareProjectCommand(ctx, synchronousCommandInput(input));
  const { file: program, args, cwd, timeoutMs, fullFilesystem } = prepared;
  const outputLimit = Math.min(prepared.outputLimit, 32 * 1024);
  const env = commanderChildEnv(cwd, process.env, { allowCodex: codexLaunchAuthorized(ctx) });
  const workflowBinding = Number.isSafeInteger(ctx.workflowOperation?.fencingToken)
    ? ctx.workflowOperation : null;
  if (workflowBinding) {
    const result = await runContainedProjectCommand({
      program, args, cwd, timeoutMs, outputLimit, env, binding:workflowBinding
    });
    await audit(ctx, {
      action:'run_project_command', program, args, cwd,
      ok:!result.isError && !result.timedOut && result.exitCode===0,
      exitCode:result.exitCode, timedOut:result.timedOut,
      powerModeFullFilesystem:fullFilesystem,
      containment:result.containment
    });
    return result;
  }
  const windowsJob = process.platform === 'win32';
  const runner = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
    '../tools/windows-job-runner/dist/win-x64/CommanderWindowsJobRunner.exe');
  // On Windows, never fall back to unmanaged spawn: taskkill /T /F may complete
  // after a descendant already performed a delayed side effect.
  if (windowsJob) {
    const info = await stat(runner);
    if (!info.isFile()) throw new Error('WINDOWS_JOB_RUNNER_NOT_INSTALLED');
  }
  const launchProgram = windowsJob ? runner : program;
  const launchArgs = windowsJob
    ? ['--timeout-ms', String(timeoutMs), '--cwd', cwd, '--', program, ...args]
    : args;
  const child = spawn(launchProgram, launchArgs, {
    cwd, windowsHide: true, shell: false,
    detached: !windowsJob,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: commanderChildEnv(cwd, process.env, { allowCodex: codexLaunchAuthorized(ctx) })
  });
  let stdout = '';
  let stderr = '';
  let stderrTail = '';
  child.stdout.on('data', (chunk) => { if (stdout.length < outputLimit) stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    if (stderr.length < outputLimit) stderr += text;
    if (windowsJob) stderrTail = (stderrTail + text).slice(-8192);
  });
  let timedOut = false;
  let timeoutTermination = null;
  // Windows native Job Objects own their own hard deadline. Node watchdog
  // is only a crash fallback: closing the runner kills its job descendants.
  const watchdogMs = windowsJob ? timeoutMs + 6000 : timeoutMs;
  const timer = setTimeout(() => {
    timedOut = true;
    const startedAt = Date.now();
    timeoutTermination = terminateProcessTree(child.pid, { signal: 'SIGKILL' });
    timeoutTermination.elapsedMs = Date.now() - startedAt;
  }, watchdogMs);
  let outcome;
  try {
    outcome = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
  } finally { clearTimeout(timer); }
  let exitCode = outcome.code;
  if (windowsJob) {
    const nativeResult = v102WindowsJobReceipt(stderrTail, outcome.code);
    if (nativeResult.timedOut) {
      timedOut = true;
      timeoutTermination = { requested: true, method: 'job-object',
        nativeConfirmed: true, processId: nativeResult.processId };
    } else {
      exitCode = nativeResult.exitCode;
    }
    stderr = stderr.replace(/RC_JOB_RESULT_JSON:\{[^\r\n]*\}\r?\n?/g, '');
  }
  const result = {
    program, args, cwd, timeoutMs, timedOut,
    ...(timedOut ? { timeoutTermination } : {}),
    exitCode, signal: outcome.signal, stdout, stderr,
    truncated: stdout.length >= outputLimit || stderr.length >= outputLimit
  };
  await audit(ctx, {
    action: 'run_project_command', program, args, cwd, ok: !timedOut && exitCode === 0,
    exitCode, timedOut, powerModeFullFilesystem: fullFilesystem
  });
  return result;
}
