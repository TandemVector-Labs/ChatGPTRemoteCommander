import os from 'node:os';
import {boundedCommandTimeout} from './command-timeout-limits.mjs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  appendFile, copyFile, cp, lstat, mkdir, readFile, readdir,
  realpath, rename, rm, stat, writeFile
} from 'node:fs/promises';
import { isWithin } from './security.mjs';
import { effectivePowerMode } from './effective-power-mode.mjs';

const terminals = new Map();
let terminalCounter = 1;

function expandEnv(value) {
  return String(value).replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? _);
}

function power(ctx) {
  const scope = effectivePowerMode(ctx.config, { accessStatus: ctx.accessStatus });
  if (scope.enabled !== true) throw new Error('Power Mode is disabled');
  return scope;
}

function resolveTarget(ctx, userPath, base = ctx.roots[0]) {
  if (typeof userPath !== 'string' || userPath.length === 0) throw new Error('path is required');
  const candidate = path.resolve(path.isAbsolute(expandEnv(userPath)) ? expandEnv(userPath) : path.join(base, expandEnv(userPath)));
  if (power(ctx).fullFilesystem !== true && !isWithin(candidate, ctx.roots)) throw new Error('path is outside allowed roots');
  return candidate;
}

function digest(data) {
  return createHash('sha256').update(data).digest('hex');
}
function backupRoot(ctx) {
  return path.resolve(expandEnv(power(ctx).backupRoot || '%USERPROFILE%\\.chatgpt-remote-commander\\backups'));
}

function backupName(target) {
  const safe = target.replace(/^([A-Za-z]):[\\/]/, '$1\\').replace(/[<>:"|?*]/g, '_');
  const stamp = new Date().toISOString().replaceAll(':', '-');
  return path.join(stamp, safe);
}

async function backupExisting(ctx, target) {
  try {
    const info = await lstat(target);
    const destination = path.join(backupRoot(ctx), backupName(target));
    await mkdir(path.dirname(destination), { recursive: true });
    if (info.isDirectory()) await cp(target, destination, { recursive: true, force: false });
    else await copyFile(target, destination);
    return destination;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function checkShell(ctx, command) {
  const cfg = power(ctx);
  if (cfg.allowShell !== true) throw new Error('shell execution is disabled');
  if (typeof command !== 'string' || command.trim().length === 0) throw new Error('command is required');
  for (const raw of cfg.blockedShellPatterns || []) {
    const pattern = new RegExp(raw, 'i');
    if (pattern.test(command)) throw new Error(`command blocked by policy: ${raw}`);
  }
  return command;
}
async function capture(command, cwd, timeoutMs, outputLimit) {
  const child = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  child.stdout.on('data', (chunk) => { if (stdout.length < outputLimit) stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { if (stderr.length < outputLimit) stderr += chunk.toString('utf8'); });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
  const outcome = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  return {
    exitCode: outcome.code, signal: outcome.signal, timedOut,
    stdout, stderr,
    truncated: stdout.length >= outputLimit || stderr.length >= outputLimit
  };
}

export async function powerStatus(ctx) {
  const cfg = power(ctx);
  return {
    enabled: true,
    fullFilesystem: cfg.fullFilesystem === true,
    allowShell: cfg.allowShell === true,
    allowProcessControl: cfg.allowProcessControl === true,
    allowPermanentDelete: cfg.allowPermanentDelete === true,
    blockedShellPatterns: cfg.blockedShellPatterns || []
  };
}
export async function fileInfo(ctx, input) {
  const target = resolveTarget(ctx, input.path);
  const info = await lstat(target);
  return {
    path: target,
    size: info.size,
    created: info.birthtime.toISOString(),
    modified: info.mtime.toISOString(),
    mode: info.mode,
    isFile: info.isFile(),
    isDirectory: info.isDirectory(),
    isSymbolicLink: info.isSymbolicLink()
  };
}

export async function readAnyFile(ctx, input) {
  const target = resolveTarget(ctx, input.path);
  const info = await stat(target);
  if (!info.isFile()) throw new Error('path is not a file');
  const maxBytes = Number(power(ctx).maxFileBytes ?? 8 * 1024 * 1024);
  if (info.size > maxBytes) throw new Error(`file exceeds Power Mode maxFileBytes (${maxBytes})`);
  const buffer = await readFile(target);
  const encoding = input.encoding === 'base64' ? 'base64' : 'utf8';
  return {
    path: target, bytes: buffer.length, sha256: digest(buffer), encoding,
    content: buffer.toString(encoding)
  };
}

export async function writeAnyFile(ctx, input) {
  const target = resolveTarget(ctx, input.path);
  const encoding = input.encoding === 'base64' ? 'base64' : 'utf8';
  const data = Buffer.from(input.content ?? '', encoding);
  const maxBytes = Number(power(ctx).maxFileBytes ?? 8 * 1024 * 1024);
  if (data.length > maxBytes) throw new Error(`content exceeds Power Mode maxFileBytes (${maxBytes})`);
  if (input.createParents !== false) await mkdir(path.dirname(target), { recursive: true });
  const backupPath = await backupExisting(ctx, target);
  if (input.mode === 'append') await appendFile(target, data);
  else await writeFile(target, data);
  const after = await readFile(target);
  return { path: target, bytes: after.length, sha256: digest(after), backupPath };
}
export async function createDirectory(ctx, input) {
  const target = resolveTarget(ctx, input.path);
  await mkdir(target, { recursive: input.recursive !== false });
  return { path: target, created: true };
}

export async function copyPath(ctx, input) {
  const source = resolveTarget(ctx, input.source);
  const destination = resolveTarget(ctx, input.destination);
  await realpath(source);
  let backupPath = null;
  try {
    await lstat(destination);
    if (input.overwrite !== true) throw new Error('destination exists; set overwrite=true');
    backupPath = await backupExisting(ctx, destination);
    await rm(destination, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: false });
  return { source, destination, backupPath };
}

export async function movePath(ctx, input) {
  const source = resolveTarget(ctx, input.source);
  const destination = resolveTarget(ctx, input.destination);
  await realpath(source);
  let backupPath = null;
  try {
    await lstat(destination);
    if (input.overwrite !== true) throw new Error('destination exists; set overwrite=true');
    backupPath = await backupExisting(ctx, destination);
    await rm(destination, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await mkdir(path.dirname(destination), { recursive: true });
  try { await rename(source, destination); }
  catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    await cp(source, destination, { recursive: true, force: false });
    await rm(source, { recursive: true, force: true });
  }
  return { source, destination, backupPath };
}
export async function deletePath(ctx, input) {
  const target = resolveTarget(ctx, input.path);
  const cfg = power(ctx);
  await lstat(target);
  if (input.permanent === true) {
    if (cfg.allowPermanentDelete !== true) throw new Error('permanent delete is disabled');
    await rm(target, { recursive: true, force: true });
    return { path: target, permanent: true, backupPath: null };
  }
  const backupPath = await backupExisting(ctx, target);
  await rm(target, { recursive: true, force: true });
  return { path: target, permanent: false, backupPath };
}

async function walkSearch(root, current, input, results, depth) {
  if (results.length >= input.maxResults || depth < 0) return;
  let entries;
  try { entries = await readdir(current, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (results.length >= input.maxResults) break;
    const full = path.join(current, entry.name);
    const rel = path.relative(root, full);
    const nameHit = input.matcher.test(entry.name) || input.matcher.test(rel);
    if (nameHit) results.push({ path: full, relativePath: rel, type: entry.isDirectory() ? 'directory' : 'file', match: 'name' });
    if (entry.isFile() && input.searchContent && results.length < input.maxResults) {
      try {
        const info = await stat(full);
        if (info.size <= input.maxContentBytes) {
          const buffer = await readFile(full);
          if (!buffer.includes(0)) {
            const text = buffer.toString('utf8');
            input.matcher.lastIndex = 0;
            if (input.matcher.test(text)) results.push({ path: full, relativePath: rel, type: 'file', match: 'content' });
          }
        }
      } catch { /* unreadable files are skipped */ }
    }
    if (entry.isDirectory() && depth > 0) await walkSearch(root, full, input, results, depth - 1);
  }
}

export async function searchFiles(ctx, input) {
  const root = resolveTarget(ctx, input.path ?? '.');
  const pattern = String(input.pattern ?? '');
  const flags = input.ignoreCase === false ? 'g' : 'gi';
  const matcher = input.regex === true ? new RegExp(pattern, flags) : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  const options = {
    matcher, searchContent: input.searchContent === true,
    maxResults: Math.max(1, Math.min(Number(input.maxResults ?? 100), 1000)),
    maxContentBytes: Math.max(1024, Math.min(Number(input.maxContentBytes ?? 1048576), 8388608))
  };
  const results = [];
  await walkSearch(root, root, options, results, Math.max(0, Math.min(Number(input.depth ?? 6), 32)));
  return { root, count: results.length, truncated: results.length >= options.maxResults, results };
}
export async function runShell(ctx, input) {
  const command = checkShell(ctx, input.command);
  const cwd = resolveTarget(ctx, input.cwd ?? ctx.roots[0]);
  const info = await stat(cwd);
  if (!info.isDirectory()) throw new Error('cwd is not a directory');
  const cfg = power(ctx);
  const timeoutMs = boundedCommandTimeout(input.timeoutMs, cfg.maxCommandMs ?? 300000);
  const outputLimit = Math.max(4096, Math.min(Number(cfg.maxOutputBytes ?? 1048576), 8388608));
  const result = await capture(command, cwd, timeoutMs, outputLimit);
  return { command, cwd, timeoutMs, ...result };
}

export async function systemInfo(ctx) {
  power(ctx);
  return {
    hostname: os.hostname(), platform: os.platform(), release: os.release(), arch: os.arch(),
    uptimeSeconds: os.uptime(), totalMemory: os.totalmem(), freeMemory: os.freemem(),
    cpus: os.cpus().map((cpu) => ({ model: cpu.model, speed: cpu.speed })),
    user: os.userInfo().username, home: os.homedir(), temp: os.tmpdir(),
    node: process.version, pid: process.pid
  };
}

export async function listProcesses(ctx) {
  power(ctx);
  const command = "Get-Process | Select-Object Id,ProcessName,CPU,WorkingSet64,Path | ConvertTo-Json -Depth 3 -Compress";
  const result = await capture(command, ctx.roots[0], 15000, 4 * 1024 * 1024);
  if (result.exitCode !== 0) throw new Error(result.stderr || 'Get-Process failed');
  let processes = [];
  if (result.stdout.trim()) {
    const parsed = JSON.parse(result.stdout);
    processes = Array.isArray(parsed) ? parsed : [parsed];
  }
  return { count: processes.length, processes };
}

export async function killProcess(ctx, input) {
  const cfg = power(ctx);
  if (cfg.allowProcessControl !== true) throw new Error('process control is disabled');
  const pid = Number(input.pid);
  if (!Number.isInteger(pid) || pid <= 4 || pid === process.pid) throw new Error('refusing protected/invalid PID');
  const lookup = await capture(`(Get-Process -Id ${pid} -ErrorAction Stop).ProcessName`, ctx.roots[0], 5000, 8192);
  if (lookup.exitCode !== 0) throw new Error(lookup.stderr || 'process not found');
  const name = lookup.stdout.trim().toLowerCase();
  const protectedNames = new Set(['system', 'registry', 'smss', 'csrss', 'wininit', 'services', 'lsass', 'winlogon']);
  if (protectedNames.has(name)) throw new Error(`refusing protected Windows process: ${name}`);
  process.kill(pid, input.signal || 'SIGTERM');
  return { pid, processName: name, signal: input.signal || 'SIGTERM', requested: true };
}
function terminalSnapshot(session, consume = true) {
  const stdout = session.stdout.slice(session.stdoutCursor);
  const stderr = session.stderr.slice(session.stderrCursor);
  if (consume) {
    session.stdoutCursor = session.stdout.length;
    session.stderrCursor = session.stderr.length;
  }
  return {
    id: session.id, pid: session.child.pid, running: session.running,
    exitCode: session.exitCode, signal: session.signal, stdout, stderr,
    truncated: session.truncated
  };
}

export async function startTerminal(ctx, input) {
  const cfg = power(ctx);
  if (cfg.allowProcessControl !== true || cfg.allowShell !== true) throw new Error('terminal control is disabled');
  const cwd = resolveTarget(ctx, input.cwd ?? ctx.roots[0]);
  const info = await stat(cwd);
  if (!info.isDirectory()) throw new Error('cwd is not a directory');
  const child = spawn('pwsh.exe', ['-NoLogo', '-NoProfile'], {
    cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
  });
  const id = `term-${terminalCounter++}`;
  const session = {
    id, child, cwd, running: true, exitCode: null, signal: null,
    stdout: '', stderr: '', stdoutCursor: 0, stderrCursor: 0, truncated: false
  };
  const limit = Math.max(65536, Math.min(Number(cfg.maxTerminalBufferBytes ?? 2097152), 16777216));
  child.stdout.on('data', (chunk) => {
    session.stdout += chunk.toString('utf8');
    if (session.stdout.length > limit) { session.stdout = session.stdout.slice(-limit); session.stdoutCursor = 0; session.truncated = true; }
  });
  child.stderr.on('data', (chunk) => {
    session.stderr += chunk.toString('utf8');
    if (session.stderr.length > limit) { session.stderr = session.stderr.slice(-limit); session.stderrCursor = 0; session.truncated = true; }
  });
  child.once('close', (code, signal) => { session.running = false; session.exitCode = code; session.signal = signal; });
  child.once('error', (error) => { session.running = false; session.stderr += `\n${error.message}\n`; });
  terminals.set(id, session);
  if (input.command) child.stdin.write(checkShell(ctx, input.command) + os.EOL);
  return { id, pid: child.pid, cwd, running: true };
}
function getTerminal(input) {
  const session = terminals.get(input.id);
  if (!session) throw new Error(`unknown terminal session: ${input.id}`);
  return session;
}

export async function readTerminal(ctx, input) {
  power(ctx);
  return terminalSnapshot(getTerminal(input), input.consume !== false);
}

export async function sendTerminal(ctx, input) {
  const session = getTerminal(input);
  if (!session.running) throw new Error('terminal session is not running');
  const text = String(input.input ?? '');
  checkShell(ctx, text);
  session.child.stdin.write(text + (input.newline === false ? '' : os.EOL));
  return { id: session.id, pid: session.child.pid, accepted: true };
}

export async function stopTerminal(ctx, input) {
  const cfg = power(ctx);
  if (cfg.allowProcessControl !== true) throw new Error('process control is disabled');
  const session = getTerminal(input);
  if (session.running) {
    const closed = new Promise((resolve) => session.child.once('close', resolve));
    session.child.kill(input.signal || 'SIGTERM');
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
  if (input.remove !== false) terminals.delete(session.id);
  return { id: session.id, pid: session.child.pid, stopRequested: true, running: session.running };
}

const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

export const powerToolDefinitions = [
  { name: 'power_status', description: 'Return Full-Control Power Mode capabilities and policy.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: ro },
  { name: 'file_info', description: 'Return metadata for any file or directory permitted by Power Mode.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, annotations: ro },
  { name: 'read_file', description: 'Read text or binary file data (base64) using Power Mode.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, encoding: { type: 'string', enum: ['utf8', 'base64'] } }, required: ['path'], additionalProperties: false }, annotations: ro },
  { name: 'write_file', description: 'Write/append text or base64 file data with automatic pre-mutation backup.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, encoding: { type: 'string', enum: ['utf8', 'base64'] }, mode: { type: 'string', enum: ['overwrite', 'append'] }, createParents: { type: 'boolean' } }, required: ['path', 'content'], additionalProperties: false }, annotations: write },
  { name: 'create_directory', description: 'Create a directory, including parents.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, recursive: { type: 'boolean' } }, required: ['path'], additionalProperties: false }, annotations: write },
  { name: 'copy_path', description: 'Copy a file or directory recursively; optionally replace destination after backup.', inputSchema: { type: 'object', properties: { source: { type: 'string' }, destination: { type: 'string' }, overwrite: { type: 'boolean' } }, required: ['source', 'destination'], additionalProperties: false }, annotations: write },
  { name: 'move_path', description: 'Move or rename a file/directory; optionally replace destination after backup.', inputSchema: { type: 'object', properties: { source: { type: 'string' }, destination: { type: 'string' }, overwrite: { type: 'boolean' } }, required: ['source', 'destination'], additionalProperties: false }, annotations: write },
  { name: 'delete_path', description: 'Delete with recoverable backup by default. Permanent deletion is separately policy-gated.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, permanent: { type: 'boolean' } }, required: ['path'], additionalProperties: false }, annotations: destructive },
  { name: 'search_files', description: 'Search names and optionally UTF-8 file content across Power Mode filesystem scope.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, pattern: { type: 'string' }, regex: { type: 'boolean' }, ignoreCase: { type: 'boolean' }, searchContent: { type: 'boolean' }, depth: { type: 'integer', minimum: 0, maximum: 32 }, maxResults: { type: 'integer', minimum: 1, maximum: 1000 }, maxContentBytes: { type: 'integer', minimum: 1024 } }, required: ['pattern'], additionalProperties: false }, annotations: ro },
  { name: 'run_shell', description: 'Run a PowerShell command with timeout/output bounds. Explicit Power Mode only.', inputSchema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 1000 } }, required: ['command'], additionalProperties: false }, annotations: destructive },
  { name: 'system_info', description: 'Return OS, CPU, memory, user, Node and runtime information.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: ro },
  { name: 'list_processes', description: 'List Windows processes with PID, resource usage and path when available.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: ro },
  { name: 'kill_process', description: 'Terminate a process by PID; protected/system PIDs and this server are refused.', inputSchema: { type: 'object', properties: { pid: { type: 'integer' }, signal: { type: 'string' } }, required: ['pid'], additionalProperties: false }, annotations: destructive },
  { name: 'start_terminal', description: 'Start a persistent pwsh terminal session and optionally run an initial command.', inputSchema: { type: 'object', properties: { cwd: { type: 'string' }, command: { type: 'string' } }, additionalProperties: false }, annotations: destructive },
  { name: 'read_terminal', description: 'Read buffered stdout/stderr and state from a persistent terminal session.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, consume: { type: 'boolean' } }, required: ['id'], additionalProperties: false }, annotations: ro },
  { name: 'send_terminal', description: 'Send input to a persistent terminal session.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, input: { type: 'string' }, newline: { type: 'boolean' } }, required: ['id', 'input'], additionalProperties: false }, annotations: destructive },
  { name: 'stop_terminal', description: 'Stop and optionally remove a persistent terminal session.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, signal: { type: 'string' }, remove: { type: 'boolean' } }, required: ['id'], additionalProperties: false }, annotations: destructive }
];
export async function executePowerTool(ctx, name, input) {
  switch (name) {
    case 'power_status': return powerStatus(ctx);
    case 'file_info': return fileInfo(ctx, input);
    case 'read_file': return readAnyFile(ctx, input);
    case 'write_file': return writeAnyFile(ctx, input);
    case 'create_directory': return createDirectory(ctx, input);
    case 'copy_path': return copyPath(ctx, input);
    case 'move_path': return movePath(ctx, input);
    case 'delete_path': return deletePath(ctx, input);
    case 'search_files': return searchFiles(ctx, input);
    case 'run_shell': return runShell(ctx, input);
    case 'system_info': return systemInfo(ctx);
    case 'list_processes': return listProcesses(ctx);
    case 'kill_process': return killProcess(ctx, input);
    case 'start_terminal': return startTerminal(ctx, input);
    case 'read_terminal': return readTerminal(ctx, input);
    case 'send_terminal': return sendTerminal(ctx, input);
    case 'stop_terminal': return stopTerminal(ctx, input);
    default: throw Object.assign(new Error(`Unknown tool: ${name}`), { rpcCode: -32602 });
  }
}
