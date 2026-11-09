#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';

const fail = (message) => {
  process.stderr.write(String(message) + '\n');
  process.exit(2);
};

function parse(argv) {
  const out = {
    logFile: '',
    statusFile: '',
    maxBytes: 8 * 1024 * 1024,
    maxFiles: 3,
    child: []
  };
  let i = 0;
  for (; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      out.child = argv.slice(i + 1);
      break;
    }
    const value = argv[i + 1];
    if (arg === '--log-file') { out.logFile = value ?? ''; i += 1; continue; }
    if (arg === '--status-file') { out.statusFile = value ?? ''; i += 1; continue; }
    if (arg === '--max-bytes') { out.maxBytes = Number(value); i += 1; continue; }
    if (arg === '--max-files') { out.maxFiles = Number(value); i += 1; continue; }
    fail('unknown argument: ' + arg);
  }
  if (!path.isAbsolute(out.logFile)) fail('--log-file must be absolute');
  if (!path.isAbsolute(out.statusFile)) fail('--status-file must be absolute');
  if (!Number.isSafeInteger(out.maxBytes) || out.maxBytes < 256 * 1024 || out.maxBytes > 64 * 1024 * 1024) {
    fail('--max-bytes must be an integer between 262144 and 67108864');
  }
  if (!Number.isSafeInteger(out.maxFiles) || out.maxFiles < 1 || out.maxFiles > 10) {
    fail('--max-files must be an integer between 1 and 10');
  }
  if (out.child.length < 2) fail('child executable and arguments are required after --');
  return out;
}

const cfg = parse(process.argv.slice(2));
const startedAt = new Date().toISOString();
let child = null;
let fd = null;
let currentBytes = 0;
let rotations = 0;
let lastRotationAt = null;
let closing = false;
let fatal = null;

function mkdirPrivate(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

mkdirPrivate(path.dirname(cfg.logFile));
mkdirPrivate(path.dirname(cfg.statusFile));

function archivePath(index) {
  return cfg.logFile + '.' + index + '.gz';
}

function countArchives() {
  let n = 0;
  for (let i = 1; i <= cfg.maxFiles; i += 1) if (fs.existsSync(archivePath(i))) n += 1;
  return n;
}

function writeStatus(active, extra = {}) {
  const body = {
    schema: 1,
    active,
    wrapperPid: process.pid,
    childPid: child?.pid ?? null,
    logFile: cfg.logFile,
    currentBytes,
    maxBytes: cfg.maxBytes,
    maxFiles: cfg.maxFiles,
    archivedFiles: countArchives(),
    rotations,
    startedAt,
    lastRotationAt,
    ...extra
  };
  const tmp = cfg.statusFile + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
  try {
    const f = fs.openSync(tmp, 'r');
    try { fs.fsyncSync(f); } finally { fs.closeSync(f); }
  } catch {}
  fs.renameSync(tmp, cfg.statusFile);
  try { fs.chmodSync(cfg.statusFile, 0o600); } catch {}
}

function openCurrent() {
  if (fd !== null) return;
  fd = fs.openSync(cfg.logFile, 'a', 0o600);
  try { fs.chmodSync(cfg.logFile, 0o600); } catch {}
  currentBytes = fs.fstatSync(fd).size;
}

function closeCurrent() {
  if (fd === null) return;
  try { fs.fsyncSync(fd); } catch {}
  try { fs.closeSync(fd); } catch {}
  fd = null;
}

function readTail(file, maxBytes) {
  const stat = fs.statSync(file);
  const length = Math.min(stat.size, maxBytes);
  const start = Math.max(0, stat.size - length);
  const buf = Buffer.alloc(length);
  if (length === 0) return buf;
  const source = fs.openSync(file, 'r');
  try {
    const count = fs.readSync(source, buf, 0, length, start);
    if (count !== length) throw new Error('LOG_TAIL_SHORT_READ');
  } finally {
    fs.closeSync(source);
  }
  return buf;
}

function rotateArchives() {
  const oldest = archivePath(cfg.maxFiles);
  try { fs.rmSync(oldest, { force: true }); } catch {}
  for (let i = cfg.maxFiles - 1; i >= 1; i -= 1) {
    const from = archivePath(i);
    const to = archivePath(i + 1);
    if (!fs.existsSync(from)) continue;
    fs.renameSync(from, to);
  }
}

function rotateCurrent(reason) {
  closeCurrent();
  if (fs.existsSync(cfg.logFile)) {
    const recent = readTail(cfg.logFile, cfg.maxBytes);
    rotateArchives();
    const compressed = gzipSync(recent, { level: 6 });
    const tmp = archivePath(1) + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, compressed, { mode: 0o600 });
    const verify = fs.readFileSync(tmp);
    if (!verify.equals(compressed) || !gunzipSync(verify).equals(recent)) {
      fs.rmSync(tmp, { force: true });
      throw new Error('LOG_ARCHIVE_VERIFICATION_FAILED');
    }
    fs.renameSync(tmp, archivePath(1));
    fs.rmSync(cfg.logFile, { force: true });
    rotations += 1;
    lastRotationAt = new Date().toISOString();
  }
  openCurrent();
  writeStatus(true, { lastRotationReason: reason });
}

function ensureStartupBound() {
  if (!fs.existsSync(cfg.logFile)) return;
  const size = fs.statSync(cfg.logFile).size;
  if (size > cfg.maxBytes) rotateCurrent('startup-legacy-oversize');
}

function writeChunk(chunk) {
  if (fatal) return;
  const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  let offset = 0;
  try {
    openCurrent();
    while (offset < data.length) {
      if (currentBytes >= cfg.maxBytes) rotateCurrent('size');
      const room = Math.max(1, cfg.maxBytes - currentBytes);
      const end = Math.min(data.length, offset + room);
      const slice = data.subarray(offset, end);
      fs.writeSync(fd, slice);
      currentBytes += slice.length;
      offset = end;
    }
  } catch (error) {
    fatal = error;
    try { child?.kill('SIGTERM'); } catch {}
  }
}

function forward(signal) {
  if (closing) return;
  closing = true;
  try {
    if (child && child.exitCode === null) child.kill(signal);
  } catch {}
  setTimeout(() => {
    try {
      if (child && child.exitCode === null) child.kill('SIGKILL');
    } catch {}
  }, 5000).unref();
}

process.on('SIGTERM', () => forward('SIGTERM'));
process.on('SIGINT', () => forward('SIGINT'));

ensureStartupBound();
openCurrent();
writeStatus(true, { lastRotationReason: rotations ? 'startup-legacy-oversize' : null });

const [exe, ...args] = cfg.child;
const childEnv = { ...process.env };
// Remove private Commander/LLM credentials before child creation.
delete childEnv.CONTROL_PLANE_API_KEY;
delete childEnv.OPENAI_API_KEY;
child = spawn(exe, args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
  windowsHide: true,
  env: childEnv
});
delete process.env.CONTROL_PLANE_API_KEY;
delete process.env.OPENAI_API_KEY;
delete childEnv.CONTROL_PLANE_API_KEY;
delete childEnv.OPENAI_API_KEY;
writeStatus(true, { lastRotationReason: rotations ? 'startup-legacy-oversize' : null });

child.stdout.on('data', writeChunk);
child.stderr.on('data', writeChunk);
child.once('error', (error) => {
  fatal = fatal ?? error;
});
child.once('close', (code, signal) => {
  closeCurrent();
  const final = fatal ? 'LOGGER_FAILURE' : 'CHILD_EXIT';
  try {
    writeStatus(false, {
      lastExitCode: code,
      lastSignal: signal,
      terminalReason: final,
      errorCode: fatal?.code ?? null,
      errorMessage: fatal ? String(fatal.message || fatal).slice(0, 500) : null
    });
  } catch {}
  process.exitCode = fatal ? 70 : (Number.isInteger(code) ? code : 1);
});
