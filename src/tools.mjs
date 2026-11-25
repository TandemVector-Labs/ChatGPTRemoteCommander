import path from 'node:path';
import {boundedCommandTimeout} from './command-timeout-limits.mjs';
import { appendFile, copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  psQuote,
  rootForPath,
  safeExistingPath,
  safeWritablePath,
  validateCommandArgs,
  validateProgram
} from './security.mjs';

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export async function audit(ctx, record) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n';
  await mkdir(path.dirname(ctx.auditLog), { recursive: true });
  await appendFile(ctx.auditLog, line, 'utf8');
}
async function walkDirectory(dir, depth, maxEntries, base, out) {
  if (out.length >= maxEntries) return;
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
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
  const target = await safeExistingPath(input.path ?? '.', ctx.roots, ctx.roots[0]);
  const info = await stat(target);
  if (!info.isDirectory()) throw new Error('path is not a directory');
  const depth = Math.max(0, Math.min(Number(input.depth ?? 1), 4));
  const maxEntries = Math.max(1, Math.min(Number(input.maxEntries ?? 200), 500));
  const entries = [];
  await walkDirectory(target, depth, maxEntries, target, entries);
  await audit(ctx, { action: 'list_directory', target, ok: true, count: entries.length });
  return { target, depth, truncated: entries.length >= maxEntries, entries };
}
export async function readText(ctx, input) {
  const target = await safeExistingPath(input.path, ctx.roots, ctx.roots[0]);
  const info = await stat(target);
  if (!info.isFile()) throw new Error('path is not a file');
  if (info.size > ctx.config.maxReadBytes) {
    throw new Error(`file exceeds maxReadBytes (${ctx.config.maxReadBytes})`);
  }
  const buffer = await readFile(target);
  if (buffer.includes(0)) throw new Error('binary files are not supported by read_text');
  const text = buffer.toString('utf8');
  const result = {
    path: target,
    bytes: buffer.length,
    sha256: sha256(buffer),
    text
  };
  await audit(ctx, { action: 'read_text', target, ok: true, bytes: buffer.length });
  return result;
}
export async function writeText(ctx, input) {
  if (typeof input.content !== 'string') throw new Error('content must be a string');
  const bytes = Buffer.byteLength(input.content, 'utf8');
  if (bytes > ctx.config.maxWriteBytes) {
    throw new Error(`content exceeds maxWriteBytes (${ctx.config.maxWriteBytes})`);
  }
  const target = await safeWritablePath(input.path, ctx.roots, ctx.roots[0]);
  const mode = input.mode === 'append' ? 'append' : 'overwrite';
  let beforeHash = null;
  let backupPath = null;
  try {
    const before = await readFile(target);
    beforeHash = sha256(before);
    if (input.expectedSha256 && input.expectedSha256 !== beforeHash) {
      throw new Error('expectedSha256 does not match current file');
    }
    const root = rootForPath(target, ctx.roots);
    const rel = path.relative(root, target);
    const stamp = new Date().toISOString().replaceAll(':', '-');
    backupPath = path.join(root, '.remote-commander-backups', stamp, rel);
    await mkdir(path.dirname(backupPath), { recursive: true });
    await copyFile(target, backupPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (mode === 'append') await appendFile(target, input.content, 'utf8');
  else await writeFile(target, input.content, 'utf8');
  const after = await readFile(target);
  const result = { path: target, mode, bytes: after.length, beforeSha256: beforeHash, sha256: sha256(after), backupPath };
  await audit(ctx, { action: 'write_text', target, ok: true, mode, bytes, backupPath });
  return result;
}
export async function runProjectCommand(ctx, input) {
  const program = validateProgram(input.program, ctx.config.allowedPrograms);
  const cwd = await safeExistingPath(input.cwd ?? '.', ctx.roots, ctx.roots[0]);
  const info = await stat(cwd);
  if (!info.isDirectory()) throw new Error('cwd is not a directory');
  const args = validateCommandArgs(program, input.args ?? [], cwd, ctx.roots);
  // The legacy project-command route must share the fail-closed timer policy
  // with current Power Shell and project commands before process creation.
  const timeoutMs = boundedCommandTimeout(input.timeoutMs, ctx.config.maxCommandMs ?? 300000);
  const command = `& ${psQuote(program)} ${args.map(psQuote).join(' ')}; exit $LASTEXITCODE`;
  const child = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  const outputLimit = 262144;
  child.stdout.on('data', (chunk) => {
    if (stdout.length < outputLimit) stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    if (stderr.length < outputLimit) stderr += chunk.toString('utf8');
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const outcome = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  const result = {
    program,
    args,
    cwd,
    timeoutMs,
    timedOut,
    exitCode: outcome.code,
    signal: outcome.signal,
    stdout,
    stderr,
    truncated: stdout.length >= outputLimit || stderr.length >= outputLimit
  };
  await audit(ctx, {
    action: 'run_project_command', program, args, cwd, ok: !timedOut && outcome.code === 0,
    exitCode: outcome.code, timedOut
  });
  return result;
}
