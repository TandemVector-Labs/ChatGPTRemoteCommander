import os from 'node:os';
import {boundedCommandTimeout} from './command-timeout-limits.mjs';
import { synchronousCommandInput } from './retry-guard.mjs';
import { effectivePowerMode } from './effective-power-mode.mjs';
import { assertNoCodexCommand, assertNoCodexShellDelegation, codexLaunchAuthorized, commanderChildEnv } from './no-codex-policy.mjs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  appendFile, copyFile, cp, lstat, mkdir, opendir, readFile, readdir,
  realpath, rename, rm, stat, writeFile
} from 'node:fs/promises';
import { isWithin, isWithinCanonical } from './security-v0.3.mjs';
import { withPathLocks } from './locks.mjs';
import { guardFileWrite } from './file-write-guard.mjs';
import { IS_WINDOWS, defaultBackupRoot, expandPathValue, shellName, shellSpec, spawnShell, terminateProcessTree } from './platform.mjs';
import { assertEnumerationScope, boundedSearchVisitLimit } from './filesystem-enumeration-guard.mjs';
import { refreshCodexPluginCache } from './codex-maintenance.mjs';
import { runContainedProjectCommand } from './process-containment.mjs';

const terminals = new Map();
let terminalCounter = 1;
const TERMINAL_READ_DEFAULT_CHARS = 32 * 1024;
const TERMINAL_READ_MAX_CHARS = 64 * 1024;
const TERMINAL_READ_MAX_WAIT_MS = 5_000;

function expandEnv(value) {
  return expandPathValue(value);
}

function power(ctx) {
  const scope = effectivePowerMode(ctx.config, { accessStatus: ctx.accessStatus });
  if (scope.enabled !== true) throw new Error('Power Mode is disabled');
  return scope;
}

function lexicalTarget(ctx, userPath, base = ctx.roots[0]) {
  if (typeof userPath !== 'string' || userPath.length === 0) throw new Error('path is required');
  const expanded = expandEnv(userPath);
  const candidate = path.resolve(path.isAbsolute(expanded) ? expanded : path.join(base, expanded));
  if (power(ctx).fullFilesystem !== true && !isWithin(candidate, ctx.roots)) throw new Error('path is outside allowed roots');
  return candidate;
}

async function nearestExistingAncestor(candidate) {
  let cursor = candidate;
  const suffix = [];
  while (true) {
    try { return { ancestor: await realpath(cursor), suffix }; }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

export async function resolveExistingTarget(ctx, userPath, base = ctx.roots[0]) {
  const candidate = lexicalTarget(ctx, userPath, base);
  const resolved = await realpath(candidate);
  if (power(ctx).fullFilesystem !== true && !isWithinCanonical(resolved, ctx.roots)) {
    throw new Error('resolved path escapes allowed roots');
  }
  return resolved;
}

export async function resolveWritableTarget(ctx, userPath, base = ctx.roots[0]) {
  const candidate = lexicalTarget(ctx, userPath, base);
  try {
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) throw new Error('symbolic-link writes are not allowed');
    const resolved = await realpath(candidate);
    if (power(ctx).fullFilesystem !== true && !isWithinCanonical(resolved, ctx.roots)) {
      throw new Error('resolved path escapes allowed roots');
    }
    return resolved;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const parentCandidate = path.dirname(candidate);
  const { ancestor, suffix } = await nearestExistingAncestor(parentCandidate);
  if (power(ctx).fullFilesystem !== true && !isWithinCanonical(ancestor, ctx.roots)) {
    throw new Error('parent path escapes allowed roots');
  }

  const canonicalParent = path.join(ancestor, ...suffix);
  return path.join(canonicalParent, path.basename(candidate));
}

function pathRelation(a, b) {
  const aa = path.resolve(a);
  const bb = path.resolve(b);
  const relAB = path.relative(aa, bb);
  const relBA = path.relative(bb, aa);
  const aContainsB = relAB !== '' && !relAB.startsWith('..') && !path.isAbsolute(relAB);
  const bContainsA = relBA !== '' && !relBA.startsWith('..') && !path.isAbsolute(relBA);
  return aa === bb ? 'same' : aContainsB ? 'source-ancestor' : bContainsA ? 'destination-ancestor' : 'disjoint';
}

function assertDisjointPaths(source, destination) {
  const relation = pathRelation(source, destination);
  if (relation !== 'disjoint') throw new Error(`source/destination relationship is unsafe: ${relation}`);
}

function digest(data) {
  return createHash('sha256').update(data).digest('hex');
}
function backupRoot(ctx) {
  const configured = power(ctx).backupRoot;
  return path.resolve(configured ? expandEnv(configured) : defaultBackupRoot());
}

function backupRetentionSnapshots(ctx) {
  const value = Number(power(ctx).backupRetentionSnapshots ?? 8);
  if (!Number.isSafeInteger(value) || value < 2 || value > 64) {
    throw new Error('backupRetentionSnapshots must be an integer between 2 and 64');
  }
  return value;
}

function backupTargetRelative(target) {
  const normalized = path.resolve(target);
  return normalized
    .replace(/^([A-Za-z]):[\\/]/, '$1/')
    .replace(/^[/\\]+/, '')
    .replace(/[<>:"|?*\u0000]/g, '_');
}

function backupStamp() {
  return `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

async function pruneFileBackups(ctx, target) {
  const root = backupRoot(ctx);
  const relative = backupTargetRelative(target);
  const variants = [relative, relative + '.append.json'];
  let entries = [];
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return { retained: 0, pruned: 0 };
    throw error;
  }
  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    for (const candidateRelative of variants) {
      const candidate = path.join(root, entry.name, candidateRelative);
      try {
        const info = await lstat(candidate);
        if (info.isFile() && !info.isSymbolicLink()) {
          matches.push({ container: path.join(root, entry.name), mtimeMs: info.mtimeMs });
          break;
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs || b.container.localeCompare(a.container));
  const keep = backupRetentionSnapshots(ctx);
  const stale = matches.slice(keep);
  for (const item of stale) await rm(item.container, { recursive: true, force: true });
  return { retained: Math.min(matches.length, keep), pruned: stale.length };
}

async function backupExisting(ctx, target) {
  try {
    const info = await lstat(target);
    const destination = path.join(backupRoot(ctx), backupStamp(), backupTargetRelative(target));
    await mkdir(path.dirname(destination), { recursive: true });
    if (info.isDirectory()) {
      await cp(target, destination, { recursive: true, force: false });
      return destination;
    }
    await copyFile(target, destination);
    const source = await readFile(target);
    const copy = await readFile(destination);
    if (source.length !== copy.length || digest(source) !== digest(copy)) {
      await rm(path.dirname(destination), { recursive: true, force: true });
      throw new Error('BACKUP_VERIFICATION_FAILED');
    }
    await pruneFileBackups(ctx, target);
    return destination;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function backupAppendRecovery(ctx, target, before, appended) {
  const destination = path.join(
    backupRoot(ctx),
    backupStamp(),
    backupTargetRelative(target) + '.append.json'
  );
  const journal = {
    schema: 1,
    kind: 'append-truncate-recovery',
    target: path.resolve(target),
    beforeBytes: before.length,
    beforeSha256: digest(before),
    appendBytes: appended.length,
    appendSha256: digest(appended),
    createdAt: new Date().toISOString()
  };
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(journal) + '\n', { mode: 0o600 });
  const verify = JSON.parse(await readFile(destination, 'utf8'));
  if (
    verify.kind !== journal.kind ||
    verify.target !== journal.target ||
    verify.beforeBytes !== journal.beforeBytes ||
    verify.beforeSha256 !== journal.beforeSha256 ||
    verify.appendBytes !== journal.appendBytes ||
    verify.appendSha256 !== journal.appendSha256
  ) {
    await rm(path.dirname(destination), { recursive: true, force: true });
    throw new Error('APPEND_RECOVERY_JOURNAL_VERIFICATION_FAILED');
  }
  await pruneFileBackups(ctx, target);
  return destination;
}

const linuxDirectGuiMutationPatterns = [
  /(?:^|[;&|()'"`\s])(?:\/usr\/bin\/)?xdotool\s+(?:type|key|keydown|keyup|click|mousedown|mouseup|mousemove|mousemove_relative|windowactivate|windowfocus|windowraise|windowmove|windowsize)\b/i,
  /(?:^|[;&|()'"`\s])(?:sudo\s+)?(?:\/[^\s'"]+\/)?(?:ydotool|wtype|xte|dotool)\b/i,
  /(?:^|[;&|()'"`\s])(?:\/usr\/bin\/)?xinput\s+(?:set-prop|set-int-prop|set-button-map|float|reattach|disable|enable|map-to-output|create-master|remove-master|set-client-pointer)\b/i,
  /(?:^|[;&|()'"`\s])(?:\/usr\/bin\/)?setxkbmap\b(?!\s+(?:-query|-print)\b)/i,
  /(?:^|[;&|()'"`\s])(?:\/usr\/bin\/)?xmodmap\b(?!\s+(?:-pke|-pm|-pp|-pk)\b)/i
];
function assertNoDirectLinuxGuiMutation(command) {
  if (process.platform !== 'linux') return;
  for (const pattern of linuxDirectGuiMutationPatterns) if (pattern.test(command)) throw new Error('direct Linux GUI/input mutation is blocked; use Remote Commander GUI APIs');
}
function checkShell(ctx, command) {
  const cfg = power(ctx);
  if (cfg.allowShell !== true) throw new Error('shell execution is disabled');
  if (typeof command !== 'string' || command.trim().length === 0) throw new Error('command is required');
  assertNoDirectLinuxGuiMutation(command);
  for (const raw of cfg.blockedShellPatterns || []) {
    const pattern = new RegExp(raw, 'i');
    if (pattern.test(command)) throw new Error(`command blocked by policy: ${raw}`);
  }
  return command;
}
async function capture(command, cwd, timeoutMs, outputLimit, {
  allowCodex = false, workflowOperation = null, file = null, args = null
} = {}) {
  const env = commanderChildEnv(cwd, process.env, { allowCodex });
  if (workflowOperation) {
    if (!file || !Array.isArray(args)) throw Object.assign(new Error('PROCESS_CONTAINMENT_COMMAND_SPEC_REQUIRED'), {
      workflowCode:'PROCESS_CONTAINMENT_COMMAND_SPEC_REQUIRED'
    });
    return runContainedProjectCommand({
      program:file, args, cwd, timeoutMs, outputLimit, env, binding:workflowOperation
    });
  }
  const child = spawnShell(command, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  child.stdout.on('data', (chunk) => { if (stdout.length < outputLimit) stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { if (stderr.length < outputLimit) stderr += chunk.toString('utf8'); });
  const timer = setTimeout(() => {
    timedOut = true;
    terminateProcessTree(child.pid, { signal: 'SIGKILL' });
  }, timeoutMs);
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
    platform: process.platform,
    shell: shellName(),
    fullFilesystem: cfg.fullFilesystem === true,
    allowShell: cfg.allowShell === true,
    allowProcessControl: cfg.allowProcessControl === true,
    allowPermanentDelete: cfg.allowPermanentDelete === true,
    guiControl: cfg.guiControl ?? { enabled: false },
    blockedShellPatterns: cfg.blockedShellPatterns || [],
    backupPolicy: {
      root: backupRoot(ctx),
      retainedSnapshotsPerTarget: backupRetentionSnapshots(ctx),
      appendRecovery: 'verified-truncate-journal'
    },
    directGuiInjectionGuard: process.platform === 'linux'
  };
}
export async function fileInfo(ctx, input) {
  const target = await resolveExistingTarget(ctx, input.path);
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
  const target = await resolveExistingTarget(ctx, input.path);
  const info = await stat(target);
  if (!info.isFile()) throw new Error('path is not a file');
  const configuredMax = Number(power(ctx).maxFileBytes ?? 8 * 1024 * 1024);
  if (info.size > configuredMax) throw new Error(`file exceeds Power Mode maxFileBytes (${configuredMax})`);
  const buffer = await readFile(target);
  const paging = input.offset !== undefined || input.maxBytes !== undefined;
  const inlineMax = 512 * 1024;
  if (!paging && buffer.length > inlineMax) {
    throw new Error('SYNCHRONOUS_READ_REQUIRES_PAGING: file exceeds 512 KiB inline limit; use offset/maxBytes');
  }
  const offset = input.offset === undefined ? 0 : Number(input.offset);
  const maxBytes = input.maxBytes === undefined ? Math.min(buffer.length, inlineMax) : Number(input.maxBytes);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > buffer.length) throw new Error('offset must be a valid byte offset');
  if ((input.encoding ?? 'utf8') !== 'base64' && paging && offset > 0 && offset < buffer.length && (buffer[offset] & 0xC0) === 0x80) throw new Error('UTF8_PAGE_OFFSET_UNSAFE');
  if (paging && (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024)) throw new Error('maxBytes must be between 1 and 262144');
  let end = paging ? Math.min(buffer.length, offset + maxBytes) : buffer.length;
  const encoding = input.encoding === 'base64' ? 'base64' : 'utf8';
  if (encoding === 'utf8' && paging && end < buffer.length) {
    while (end > offset && (buffer[end] & 0xC0) === 0x80) end -= 1;
    if (end === offset) throw new Error('UTF8_PAGE_BOUNDARY_UNSAFE');
  }
  const page = buffer.subarray(offset, end);
  if (encoding === 'utf8' && page.includes(0)) throw new Error('binary file requires base64 encoding');
  const content = encoding === 'utf8'
    ? new TextDecoder('utf-8', { fatal: true }).decode(page)
    : page.toString('base64');
  return {
    path: target, bytes: page.length, fileBytes: buffer.length, offset,
    nextOffset: end < buffer.length ? end : null, truncated: end < buffer.length,
    sha256: digest(buffer), chunkSha256: digest(page), encoding, content
  };
}
export async function writeAnyFile(ctx, input) {
  if (input.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.expectedSha256)) throw new Error('expectedSha256 must be a lowercase 64-hex SHA-256');
  const target = await resolveWritableTarget(ctx, input.path);
  const encoding = input.encoding === 'base64' ? 'base64' : 'utf8';
  const data = Buffer.from(input.content ?? '', encoding);
  const maxBytes = Math.min(512 * 1024, Number(power(ctx).maxFileBytes ?? 8 * 1024 * 1024));
  if (data.length > maxBytes) throw new Error(`content exceeds synchronous write limit (${maxBytes}); use bounded append chunks`);
  return withPathLocks([target], async () => {
    const snapshot = await guardFileWrite(target);
    let beforeSha256 = null;
    let beforeBuffer = null;
    try {
      const before = await readFile(target);
      beforeBuffer = before;
      beforeSha256 = digest(before);
      if (input.expectedSha256 && input.expectedSha256 !== beforeSha256) {
        throw new Error('expectedSha256 does not match current file');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (input.expectedSha256 !== undefined) throw new Error('expectedSha256 precondition failed: target does not exist');
    }
    await guardFileWrite(target, snapshot);
    if (input.createParents !== false) await mkdir(path.dirname(target), { recursive: true });
    await guardFileWrite(target, snapshot);
    const mode = input.mode === 'append' ? 'append' : 'overwrite';
    const backupPath = beforeBuffer
      ? (mode === 'append'
        ? await backupAppendRecovery(ctx, target, beforeBuffer, data)
        : await backupExisting(ctx, target))
      : null;
    await guardFileWrite(target, snapshot);
    if (mode === 'append') await appendFile(target, data);
    else await writeFile(target, data);
    const after = await readFile(target);
    if (mode === 'append' && beforeBuffer) {
      if (after.length !== beforeBuffer.length + data.length) throw new Error('APPEND_POSTCONDITION_FAILED');
      if (digest(after.subarray(0, beforeBuffer.length)) !== beforeSha256) throw new Error('APPEND_PREFIX_CHANGED');
      if (digest(after.subarray(beforeBuffer.length)) !== digest(data)) throw new Error('APPEND_PAYLOAD_CHANGED');
    }
    return {
      path: target,
      bytes: after.length,
      beforeSha256,
      sha256: digest(after),
      backupPath,
      backupKind: backupPath ? (mode === 'append' ? 'append-truncate-recovery' : 'snapshot') : null
    };
  });
}
export async function createDirectory(ctx, input) {
  const target = await resolveWritableTarget(ctx, input.path);
  return withPathLocks([target], async () => {
    await mkdir(target, { recursive: input.recursive !== false });
    return { path: target, created: true };
  });
}

export async function copyPath(ctx, input) {
  const source = await resolveExistingTarget(ctx, input.source);
  const destination = await resolveWritableTarget(ctx, input.destination);
  assertDisjointPaths(source, destination);
  return withPathLocks([source, destination], async () => {
    const sourceNow = await resolveExistingTarget(ctx, source);
    const destinationNow = await resolveWritableTarget(ctx, destination);
    assertDisjointPaths(sourceNow, destinationNow);
    await mkdir(path.dirname(destinationNow), { recursive: true });
    const stage = path.join(path.dirname(destinationNow), `.rc-stage-${randomUUID()}`);
    const displaced = path.join(path.dirname(destinationNow), `.rc-displaced-${randomUUID()}`);
    let backupPath = null;
    let displacedExists = false;
    try {
      await cp(sourceNow, stage, { recursive: true, force: false, errorOnExist: true });
      try {
        await lstat(destinationNow);
        if (input.overwrite !== true) throw new Error('destination exists; set overwrite=true');
        backupPath = await backupExisting(ctx, destinationNow);
        await rename(destinationNow, displaced);
        displacedExists = true;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      await rename(stage, destinationNow);
      if (displacedExists) await rm(displaced, { recursive: true, force: true });
      return { source: sourceNow, destination: destinationNow, backupPath, transactional: true };
    } catch (error) {
      try { await rm(stage, { recursive: true, force: true }); } catch {}
      if (displacedExists) {
        try {
          await rm(destinationNow, { recursive: true, force: true });
          await rename(displaced, destinationNow);
        } catch {}
      }
      throw error;
    }
  });
}

export async function movePath(ctx, input) {
  const source = await resolveExistingTarget(ctx, input.source);
  const destination = await resolveWritableTarget(ctx, input.destination);
  assertDisjointPaths(source, destination);
  return withPathLocks([source, destination], async () => {
    const sourceNow = await resolveExistingTarget(ctx, source);
    const destinationNow = await resolveWritableTarget(ctx, destination);
    assertDisjointPaths(sourceNow, destinationNow);
    await mkdir(path.dirname(destinationNow), { recursive: true });
    const stage = path.join(path.dirname(destinationNow), `.rc-stage-${randomUUID()}`);
    const displaced = path.join(path.dirname(destinationNow), `.rc-displaced-${randomUUID()}`);
    let backupPath = null;
    let displacedExists = false;
    let promoted = false;
    let sourceDeletionStarted = false;
    try {
      await cp(sourceNow, stage, { recursive: true, force: false, errorOnExist: true });
      try {
        await lstat(destinationNow);
        if (input.overwrite !== true) throw new Error('destination exists; set overwrite=true');
        backupPath = await backupExisting(ctx, destinationNow);
        await rename(destinationNow, displaced);
        displacedExists = true;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      await rename(stage, destinationNow);
      promoted = true;
      sourceDeletionStarted = true;
      await rm(sourceNow, { recursive: true, force: true });
      if (displacedExists) await rm(displaced, { recursive: true, force: true });
      return { source: sourceNow, destination: destinationNow, backupPath, transactional: true };
    } catch (error) {
      if (promoted && sourceDeletionStarted) {
        // Source deletion may have removed SOME entries before failing. The
        // destination is now the only complete copy. Never delete it to restore
        // an overwritten target; keep displaced/backup copies for reconciliation.
        const recovery = { source: sourceNow, destination: destinationNow,
          displaced: displacedExists ? displaced : null, backupPath,
          destinationPreserved: true, sourceMayBePartial: true };
        throw Object.assign(new Error('MOVE_RECOVERY_REQUIRED ' + JSON.stringify(recovery)), { recovery, cause: error });
      }
      try { await rm(stage, { recursive: true, force: true }); } catch {}
      if (promoted) {
        // If source deletion failed, preserve both copies rather than risking data loss.
        try { await lstat(sourceNow); }
        catch { try { await rename(destinationNow, sourceNow); promoted = false; } catch {} }
      }
      if (displacedExists) {
        try {
          await rm(destinationNow, { recursive: true, force: true });
          await rename(displaced, destinationNow);
        } catch {}
      }
      throw error;
    }
  });
}
export async function deletePath(ctx, input) {
  const target = await resolveExistingTarget(ctx, input.path);
  const cfg = power(ctx);
  return withPathLocks([target], async () => {
    await lstat(target);
    if (input.permanent === true) {
      if (cfg.allowPermanentDelete !== true) throw new Error('permanent delete is disabled');
      await rm(target, { recursive: true, force: true });
      return { path: target, permanent: true, backupPath: null };
    }
    const backupPath = await backupExisting(ctx, target);
    await rm(target, { recursive: true, force: true });
    return { path: target, permanent: false, backupPath };
  });
}

async function walkSearch(root, current, input, results, depth) {
  if (results.length >= input.maxResults || depth < 0 || Date.now() >= input.deadline || input.visitLimitHit) return;
  let directory;
  try { directory = await opendir(current, { bufferSize: 1 }); }
  catch { return; }
  for await (const entry of directory) {
    if (results.length >= input.maxResults || Date.now() >= input.deadline || input.visitLimitHit) break;
    if (input.visitedEntries >= input.maxVisitedEntries) {
      input.visitLimitHit = true;
      break;
    }
    input.visitedEntries += 1;
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
  const root = await resolveExistingTarget(ctx, input.path ?? '.');
  const depth = Math.max(0, Math.min(Number(input.depth ?? 6), 32));
  assertEnumerationScope({ target: root, depth, operation: 'search_files' });
  const pattern = String(input.pattern ?? '');
  const flags = input.ignoreCase === false ? 'g' : 'gi';
  const matcher = input.regex === true ? new RegExp(pattern, flags) : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  const options = {
    matcher, searchContent: input.searchContent === true,
    maxResults: Math.max(1, Math.min(Number(input.maxResults ?? 100), 200)),
    maxContentBytes: Math.max(1024, Math.min(Number(input.maxContentBytes ?? 262144), 1048576)),
    maxVisitedEntries: boundedSearchVisitLimit(input.maxVisitedEntries),
    visitedEntries: 0,
    visitLimitHit: false,
    deadline: Date.now() + Math.max(100, Math.min(Number(input.maxDurationMs ?? 5000), 10000))
  };
  const results = [];
  await walkSearch(root, root, options, results, depth);
  const timedOut = Date.now() >= options.deadline;
  return {
    root, count: results.length,
    truncated: timedOut || options.visitLimitHit || results.length >= options.maxResults,
    timedOut, visitLimitHit: options.visitLimitHit, visitedEntries: options.visitedEntries, results
  };
}
export async function prepareShellCommand(ctx, input) {
  const command = checkShell(ctx, input.command);
  const cwd = await resolveExistingTarget(ctx, input.cwd ?? ctx.roots[0]);
  const allowCodex = codexLaunchAuthorized(ctx);
  assertNoCodexCommand(command, { allowCodex });
  await assertNoCodexShellDelegation(command, cwd, { allowCodex });
  const info = await stat(cwd);
  if (!info.isDirectory()) throw new Error('cwd is not a directory');
  const cfg = power(ctx);
  const timeoutMs = boundedCommandTimeout(input.timeoutMs, cfg.maxCommandMs ?? 300000);
  const outputLimit = Math.max(4096, Math.min(Number(cfg.maxOutputBytes ?? 1048576), 8388608));
  const spec = shellSpec(command);
  return { file: spec.file, args: spec.args, cwd, timeoutMs, outputLimit, allowCodex };
}
export async function runShell(ctx, input) {
  const guarded = synchronousCommandInput(input);
  const prepared = await prepareShellCommand(ctx, guarded);
  const outputLimit = Math.min(prepared.outputLimit, 32 * 1024);
  const result = await capture(input.command, prepared.cwd, prepared.timeoutMs, outputLimit, { allowCodex: prepared.allowCodex, workflowOperation: Number.isSafeInteger(ctx.workflowOperation?.fencingToken) ? ctx.workflowOperation : null, file: prepared.file, args: prepared.args });
  return { command: input.command, cwd: prepared.cwd, timeoutMs: prepared.timeoutMs, ...result };
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
  if (IS_WINDOWS) {
    const command = "Get-Process | Select-Object Id,ProcessName,CPU,WorkingSet64,Path | ConvertTo-Json -Depth 3 -Compress";
    const result = await capture(command, ctx.roots[0], 15000, 4 * 1024 * 1024);
    if (result.exitCode !== 0) throw new Error(result.stderr || 'Get-Process failed');
    let processes = [];
    if (result.stdout.trim()) {
      const parsed = JSON.parse(result.stdout);
      processes = Array.isArray(parsed) ? parsed : [parsed];
    }
    return { platform: 'windows', count: processes.length, processes };
  }
  const child = spawn('ps', ['-eo', 'pid=,comm=,%cpu=,rss=,args='], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  const outputLimit = 4 * 1024 * 1024;
  let outputExceeded = false;
  child.stdout.on('data', (chunk) => {
    if (Buffer.byteLength(stdout) + chunk.length > outputLimit) { outputExceeded = true; child.kill('SIGKILL'); return; }
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    if (Buffer.byteLength(stderr) + chunk.length <= 65536) stderr += chunk.toString('utf8');
  });
  const code = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(reject, new Error('PROCESS_LIST_TIMEOUT')); }, 10000);
    child.once('error', error => finish(reject, error));
    child.once('close', value => finish(resolve, value));
  });
  if (outputExceeded) throw new Error('PROCESS_LIST_OUTPUT_LIMIT');
  if (code !== 0) throw new Error(stderr || 'ps failed');
  const processes = stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s*(.*)$/);
    if (!match) return { raw: line.trim() };
    return { Id: Number(match[1]), ProcessName: match[2], CPU: Number(match[3]), WorkingSet64: Number(match[4]) * 1024, CommandLine: match[5] };
  });
  return { platform: process.platform, count: processes.length, processes };
}

export async function killProcess(ctx, input) {
  const cfg = power(ctx);
  if (cfg.allowProcessControl !== true) throw new Error('process control is disabled');
  const pid = Number(input.pid);
  const minProtected = IS_WINDOWS ? 4 : 1;
  if (!Number.isInteger(pid) || pid <= minProtected || pid === process.pid) throw new Error('refusing protected/invalid PID');
  let name = '';
  if (IS_WINDOWS) {
    const lookup = await capture(`(Get-Process -Id ${pid} -ErrorAction Stop).ProcessName`, ctx.roots[0], 5000, 8192);
    if (lookup.exitCode !== 0) throw new Error(lookup.stderr || 'process not found');
    name = lookup.stdout.trim().toLowerCase();
    const protectedNames = new Set(['system', 'registry', 'smss', 'csrss', 'wininit', 'services', 'lsass', 'winlogon']);
    if (protectedNames.has(name)) throw new Error(`refusing protected Windows process: ${name}`);
  } else {
    try { name = (await readFile(`/proc/${pid}/comm`, 'utf8')).trim().toLowerCase(); }
    catch { process.kill(pid, 0); name = `pid-${pid}`; }
    const protectedNames = new Set(['systemd', 'init', 'kthreadd']);
    if (protectedNames.has(name)) throw new Error(`refusing protected Linux process: ${name}`);
  }
  process.kill(pid, input.signal || 'SIGTERM');
  return { pid, processName: name, signal: input.signal || 'SIGTERM', requested: true };
}
function terminalReadOffset(value, fallback, total) {
  if (value === undefined) return Math.min(fallback, total);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('terminal offsets must be non-negative safe integers');
  return Math.min(parsed, total);
}

function terminalSnapshot(session, input = {}) {
  const consume = input.consume !== false;
  const maxChars = Math.max(1, Math.min(Number(input.maxChars ?? TERMINAL_READ_DEFAULT_CHARS), TERMINAL_READ_MAX_CHARS));
  if (!Number.isSafeInteger(maxChars)) throw new Error('maxChars must be a safe integer');
  const stdoutAbsolute = input.stdoutOffset !== undefined;
  const stderrAbsolute = input.stderrOffset !== undefined;
  const stdoutOffset = terminalReadOffset(input.stdoutOffset, session.stdoutCursor, session.stdout.length);
  const stderrOffset = terminalReadOffset(input.stderrOffset, session.stderrCursor, session.stderr.length);
  const stdoutEnd = Math.min(session.stdout.length, stdoutOffset + maxChars);
  const stderrEnd = Math.min(session.stderr.length, stderrOffset + maxChars);
  const stdout = session.stdout.slice(stdoutOffset, stdoutEnd);
  const stderr = session.stderr.slice(stderrOffset, stderrEnd);
  if (consume) {
    if (!stdoutAbsolute) session.stdoutCursor = stdoutEnd;
    if (!stderrAbsolute) session.stderrCursor = stderrEnd;
  }
  return {
    id: session.id, pid: session.child.pid, running: session.running,
    exitCode: session.exitCode, signal: session.signal, stdout, stderr,
    stdoutOffset, stderrOffset,
    nextStdoutOffset: stdoutEnd < session.stdout.length ? stdoutEnd : null,
    nextStderrOffset: stderrEnd < session.stderr.length ? stderrEnd : null,
    stdoutRemainingChars: Math.max(0, session.stdout.length - stdoutEnd),
    stderrRemainingChars: Math.max(0, session.stderr.length - stderrEnd),
    maxChars,
    truncated: session.truncated, interactive: session.interactive === true,
    autoClose: session.interactive !== true
  };
}

export async function codexPluginRefresh(ctx, input) {
  power(ctx);
  const next = { ...input };
  if (input.cwd !== undefined) {
    const cwd = await resolveExistingTarget(ctx, input.cwd);
    const info = await stat(cwd);
    if (!info.isDirectory()) throw new Error('cwd is not a directory');
    next.cwd = cwd;
  }
  return refreshCodexPluginCache(ctx, next);
}

export async function startTerminal(ctx, input) {
  const cfg = power(ctx);
  if (cfg.allowProcessControl !== true || cfg.allowShell !== true) throw new Error('terminal control is disabled');
  const cwd = await resolveExistingTarget(ctx, input.cwd ?? ctx.roots[0]);
  const info = await stat(cwd);
  if (!info.isDirectory()) throw new Error('cwd is not a directory');
  const hasCommand = typeof input.command === 'string' && input.command.length > 0;
  const interactive = input.interactive === true || !hasCommand;
  const command = hasCommand ? checkShell(ctx, input.command) : '';
  if (hasCommand) {
    const allowCodex = codexLaunchAuthorized(ctx);
    assertNoCodexCommand(command, { allowCodex });
    await assertNoCodexShellDelegation(command, cwd, { allowCodex });
  }
  const child = spawnShell(interactive && !IS_WINDOWS ? '' : command, {
    cwd, interactive, stdio: ['pipe', 'pipe', 'pipe'], env: commanderChildEnv(cwd, process.env, { allowCodex: codexLaunchAuthorized(ctx) })
  });
  const id = `term-${terminalCounter++}`;
  const session = {
    id, child, cwd, interactive, running: true, exitCode: null, signal: null,
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
  if (hasCommand && interactive && !IS_WINDOWS) child.stdin.write(command + os.EOL);
  return { id, pid: child.pid, cwd, running: true, interactive, autoClose: !interactive };
}
function getTerminal(input) {
  const session = terminals.get(input.id);
  if (!session) throw new Error(`unknown terminal session: ${input.id}`);
  return session;
}

export async function readTerminal(ctx, input) {
  power(ctx);
  const session = getTerminal(input);
  const waitMs = Math.max(0, Math.min(Number(input.waitMs ?? 0), TERMINAL_READ_MAX_WAIT_MS));
  if (!Number.isSafeInteger(waitMs)) throw new Error('waitMs must be a safe integer');
  if (waitMs > 0 && session.running) {
    const stdoutOffset = terminalReadOffset(input.stdoutOffset, session.stdoutCursor, session.stdout.length);
    const stderrOffset = terminalReadOffset(input.stderrOffset, session.stderrCursor, session.stderr.length);
    if (stdoutOffset >= session.stdout.length && stderrOffset >= session.stderr.length) {
      const deadline = Date.now() + waitMs;
      while (session.running && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
        if (stdoutOffset < session.stdout.length || stderrOffset < session.stderr.length) break;
      }
    }
  }
  return terminalSnapshot(session, input);
}

export async function sendTerminal(ctx, input) {
  const session = getTerminal(input);
  if (session.interactive !== true) throw new Error('terminal session is one-shot and does not accept input');
  if (!session.running) throw new Error('terminal session is not running');
  const text = String(input.input ?? '');
  checkShell(ctx, text);
  const allowCodex = codexLaunchAuthorized(ctx);
  assertNoCodexCommand(text, { allowCodex });
  await assertNoCodexShellDelegation(text, session.cwd, { allowCodex });
  session.child.stdin.write(text + (input.newline === false ? '' : os.EOL));
  return { id: session.id, pid: session.child.pid, accepted: true };
}

export async function stopTerminal(ctx, input) {
  const cfg = power(ctx);
  if (cfg.allowProcessControl !== true) throw new Error('process control is disabled');
  const session = getTerminal(input);
  if (session.running) {
    const closed = new Promise((resolve) => session.child.once('close', resolve));
    terminateProcessTree(session.child.pid, { signal: input.signal || 'SIGTERM' });
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1500))]);
    if (session.running) {
      terminateProcessTree(session.child.pid, { signal: 'SIGKILL' });
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 500))]);
    }
  }
  if (input.remove !== false) terminals.delete(session.id);
  return { id: session.id, pid: session.child.pid, stopRequested: true, running: session.running };
}

const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const additive = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const localDestructive = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const openDestructive = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const continuationInputSchema = {
  type: 'object',
  properties: {
    projectId: { type: 'string', minLength: 1, maxLength: 128 },
    eventKey: { type: 'string', minLength: 1, maxLength: 128 },
    root: { type: 'string', minLength: 1, maxLength: 4096 },
    phase: { type: 'string', maxLength: 256 },
    summary: { type: 'string', maxLength: 1200 },
    evidencePaths: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 512 } }
  },
  required: ['projectId', 'eventKey', 'root'],
  additionalProperties: false
};

export const powerToolDefinitions = [
  { name: 'power_status', description: 'Return Full-Control Power Mode capabilities, backup-retention policy, and safety policy.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: ro },
  { name: 'file_info', description: 'Return metadata for any file or directory permitted by Power Mode.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, annotations: ro },
  { name: 'read_file', description: 'Read bounded text or binary data using Power Mode. Files above 512 KiB require offset/maxBytes paging; each page is at most 256 KiB.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, encoding: { type: 'string', enum: ['utf8', 'base64'] }, offset: { type: 'integer', minimum: 0 }, maxBytes: { type: 'integer', minimum: 1, maximum: 262144 } }, required: ['path'], additionalProperties: false }, annotations: ro },
  { name: 'write_file', description: 'Write/append text or base64 file data with recoverable pre-mutation protection and optional SHA-256 precondition. Append uses compact verified truncate-recovery journals; file rollback points use bounded per-target retention.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, encoding: { type: 'string', enum: ['utf8', 'base64'] }, mode: { type: 'string', enum: ['overwrite', 'append'] }, createParents: { type: 'boolean' }, expectedSha256: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false }, annotations: localDestructive },
  { name: 'create_directory', description: 'Create a directory, including parents.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, recursive: { type: 'boolean' } }, required: ['path'], additionalProperties: false }, annotations: additive },
  { name: 'copy_path', description: 'Copy a file or directory recursively in a durable detached operation; optionally replace destination after backup. When this exact chat is already conversation-bound, include continuation for terminal handoff.', inputSchema: { type: 'object', properties: { source: { type: 'string' }, destination: { type: 'string' }, overwrite: { type: 'boolean' }, continuation: continuationInputSchema }, required: ['source', 'destination'], additionalProperties: false }, annotations: localDestructive },
  { name: 'move_path', description: 'Move or rename a file/directory in a durable detached operation; optionally replace destination after backup. When this exact chat is already conversation-bound, include continuation for terminal handoff.', inputSchema: { type: 'object', properties: { source: { type: 'string' }, destination: { type: 'string' }, overwrite: { type: 'boolean' }, continuation: continuationInputSchema }, required: ['source', 'destination'], additionalProperties: false }, annotations: localDestructive },
  { name: 'delete_path', description: 'Delete in a durable detached operation with recoverable backup by default. Permanent deletion is separately policy-gated. When this exact chat is already conversation-bound, include continuation for terminal handoff.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, permanent: { type: 'boolean' }, continuation: continuationInputSchema }, required: ['path'], additionalProperties: false }, annotations: localDestructive },
  { name: 'search_files', description: 'Search names and optionally bounded UTF-8 file content across Power Mode filesystem scope. The synchronous search is time-, result-, and entry-visit-bounded; recursive scans of a bare Windows volume root are refused.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, pattern: { type: 'string' }, regex: { type: 'boolean' }, ignoreCase: { type: 'boolean' }, searchContent: { type: 'boolean' }, depth: { type: 'integer', minimum: 0, maximum: 32 }, maxResults: { type: 'integer', minimum: 1, maximum: 1000 }, maxContentBytes: { type: 'integer', minimum: 1024 }, maxDurationMs: { type: 'integer', minimum: 100, maximum: 10000 }, maxVisitedEntries: { type: 'integer', minimum: 1, maximum: 5000 } }, required: ['pattern'], additionalProperties: false }, annotations: ro },
  { name: 'codex_plugin_refresh', description: 'Force-refresh Codex local plugin marketplace/cache through a short-lived app-server sidecar. Maintenance only: no prompts, exec, review, agent delegation, or arbitrary Codex arguments are accepted. Requires explicit confirmation from the current user request.', inputSchema: { type: 'object', properties: { confirmCurrentRequest: { type: 'boolean', enum: [true] }, cwd: { type: 'string' }, pluginName: { type: 'string', minLength: 1, maxLength: 256 }, timeoutMs: { type: 'integer', minimum: 1000, maximum: 8000 } }, required: ['confirmCurrentRequest'], additionalProperties: false }, annotations: openDestructive },
  { name: 'run_shell', description: 'Run a short bounded platform shell command (PowerShell 7 on Windows, Bash on Linux). Synchronous execution is hard-limited to 10 seconds with compact output. Use operation_start for longer/unknown/high-output work; if operation tools are not exposed by the client, use one-shot start_terminal + bounded read_terminal. Explicit Power Mode only.', inputSchema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 1000, maximum: 30000 } }, required: ['command'], additionalProperties: false }, annotations: openDestructive },
  { name: 'system_info', description: 'Return OS, CPU, memory, user, Node and runtime information.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: ro },
  { name: 'list_processes', description: 'List operating-system processes with PID and resource details when available.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: ro },
  { name: 'kill_process', description: 'Terminate a process by PID; protected/system PIDs and this server are refused.', inputSchema: { type: 'object', properties: { pid: { type: 'integer' }, signal: { type: 'string' } }, required: ['pid'], additionalProperties: false }, annotations: localDestructive },
  { name: 'start_terminal', description: 'Start a platform terminal session and return immediately. With command and no interactive=true it is a one-shot background fallback for long or high-output work when operation_* tools are unavailable; retrieve output using bounded read_terminal pages. Use interactive=true only when later send_terminal input is genuinely required. With no command it remains interactive.', inputSchema: { type: 'object', properties: { cwd: { type: 'string' }, command: { type: 'string' }, interactive: { type: 'boolean' } }, additionalProperties: false }, annotations: openDestructive },
  { name: 'read_terminal', description: 'Read a bounded page of buffered terminal stdout/stderr. By default consume=true advances session output cursors; use consume=false for a non-consuming observation. Default is 32 KiB per stream; maxChars is capped at 64 KiB. Optional waitMs long-polls for new output for at most 5 seconds. Use nextStdoutOffset/nextStderrOffset for absolute paging without skipping unread output.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, consume: { type: 'boolean' }, stdoutOffset: { type: 'integer', minimum: 0 }, stderrOffset: { type: 'integer', minimum: 0 }, maxChars: { type: 'integer', minimum: 1, maximum: 65536 }, waitMs: { type: 'integer', minimum: 0, maximum: 5000 } }, required: ['id'], additionalProperties: false }, annotations: { ...ro, readOnlyHint: false } },
  { name: 'send_terminal', description: 'Send input to an explicitly interactive terminal session. One-shot command sessions reject input.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, input: { type: 'string' }, newline: { type: 'boolean' } }, required: ['id', 'input'], additionalProperties: false }, annotations: openDestructive },
  { name: 'stop_terminal', description: 'Stop and optionally remove a persistent terminal session.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, signal: { type: 'string' }, remove: { type: 'boolean' } }, required: ['id'], additionalProperties: false }, annotations: localDestructive }
];
export async function prepareDeferredPowerMutation(ctx, name, input) {
  const cfg = power(ctx);
  if (name === 'copy_path' || name === 'move_path') {
    const source = await resolveExistingTarget(ctx, input.source);
    const destination = await resolveWritableTarget(ctx, input.destination);
    assertDisjointPaths(source, destination);
    await lstat(source);
    try {
      await lstat(destination);
      if (input.overwrite !== true) throw new Error('destination exists; set overwrite=true');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return { kind: 'power-tool', timeoutMs: 24 * 60 * 60 * 1000 };
  }
  if (name === 'delete_path') {
    const target = await resolveExistingTarget(ctx, input.path);
    await lstat(target);
    if (input.permanent === true && cfg.allowPermanentDelete !== true) throw new Error('permanent delete is disabled');
    return { kind: 'power-tool', timeoutMs: 24 * 60 * 60 * 1000 };
  }
  throw new Error('unsupported deferred power mutation');
}

async function executePowerToolLocal(ctx, name, input) {
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
    case 'codex_plugin_refresh': return codexPluginRefresh(ctx, input);
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

const V102_PROTECTED_POWER_EFFECTS = new Set([
  'write_file', 'create_directory', 'copy_path', 'move_path', 'delete_path',
  'run_shell', 'kill_process', 'start_terminal', 'send_terminal',
  'stop_terminal', 'codex_plugin_refresh'
]);

// The trusted Host injects executionAccess.run after verifying the
// originating caller/owner and exact action. No provider means no mutation.
// Preserve the legacy interface for profiles not enrolled in this policy.
export async function executePowerTool(ctx, name, input) {
  if (ctx?.config?.executionAccess?.required !== true
      || !V102_PROTECTED_POWER_EFFECTS.has(name)) {
    return executePowerToolLocal(ctx, name, input);
  }
  if (typeof ctx?.executionAccess?.run !== 'function') {
    throw Object.assign(new Error('V102_EXECUTION_ACCESS_REQUIRED'),
      { code: 'V102_EXECUTION_ACCESS_REQUIRED' });
  }
  const outcome = await ctx.executionAccess.run({ tool: name, args: input },
    () => executePowerToolLocal(ctx, name, input));
  if (!outcome || typeof outcome !== 'object'
      || !Object.hasOwn(outcome, 'result') || !outcome.authorization) {
    throw Object.assign(new Error('V102_EXECUTION_RECEIPT_REQUIRED'),
      { code: 'V102_EXECUTION_RECEIPT_REQUIRED' });
  }
  return outcome.result;
}
