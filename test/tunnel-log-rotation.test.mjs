import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const runner = path.join(root, 'tools', 'tunnel-log-runner.mjs');
const fixture = path.join(root, 'test', 'tunnel-log-child-fixture.mjs');

// Preserve exact byte equality, but never ask AssertionError to format
// a megabyte-scale binary diff. Failure metadata is fixed-size.
function assertBytesEqual(actual, expected, label) {
  if (actual.equals(expected)) return;
  let firstMismatch = 0;
  while (firstMismatch < Math.min(actual.length, expected.length) && actual[firstMismatch] === expected[firstMismatch]) firstMismatch++;
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.fail(JSON.stringify({code:'BINARY_EQUALITY_FAILED',label,actualBytes:actual.length,expectedBytes:expected.length,firstMismatch,actualSha256:digest(actual),expectedSha256:digest(expected)}));
}

function assertMergedPipeBytes(actual, { chunks, chunkBytes, marker = Buffer.from('TUNNEL_CHILD_DONE\n') }) {
  const expectedBytes = chunks * chunkBytes + marker.length;
  assert.equal(actual.length, expectedBytes, 'merged logger byte count must be exact');
  const markerIndex = actual.indexOf(marker);
  assert.ok(markerIndex >= 0, 'stdout completion marker must be present');
  assert.equal(actual.indexOf(marker, markerIndex + 1), -1, 'stdout completion marker must occur exactly once');

  const payload = Buffer.concat([actual.subarray(0, markerIndex), actual.subarray(markerIndex + marker.length)]);
  assert.equal(payload.length, chunks * chunkBytes);
  const first = Array(chunks).fill(-1);
  const last = Array(chunks).fill(-1);
  const counts = Array(chunks).fill(0);
  for (let pos = 0; pos < payload.length; pos += 1) {
    const index = payload[pos] - 65;
    if (index < 0 || index >= chunks) {
      assert.fail(JSON.stringify({ code: 'MERGED_PIPE_UNEXPECTED_BYTE', pos, value: payload[pos] }));
    }
    if (first[index] < 0) first[index] = pos;
    last[index] = pos;
    counts[index] += 1;
  }
  for (let index = 0; index < chunks; index += 1) {
    assert.equal(counts[index], chunkBytes, `chunk ${index} byte count must be exact`);
  }

  const assertPipeOrder = indexes => {
    for (let i = 1; i < indexes.length; i += 1) {
      const before = indexes[i - 1], after = indexes[i];
      assert.ok(last[before] < first[after], `pipe order must preserve chunk ${before} before ${after}`);
    }
  };
  assertPipeOrder(Array.from({ length: chunks }, (_, i) => i).filter(i => i % 5 !== 4));
  assertPipeOrder(Array.from({ length: chunks }, (_, i) => i).filter(i => i % 5 === 4));

  let lastFinalStdout = -1;
  const finalStdoutByte = 65 + (chunks - 1);
  for (let pos = 0; pos < actual.length; pos += 1) {
    if (pos >= markerIndex && pos < markerIndex + marker.length) continue;
    if (actual[pos] === finalStdoutByte) lastFinalStdout = pos;
  }
  assert.ok(lastFinalStdout >= 0 && lastFinalStdout < markerIndex, 'completion marker must follow the final stdout chunk');
}

function run(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { ...options, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout?.on('data', c => { stdout += c.toString(); });
    child.stderr?.on('data', c => { stderr += c.toString(); });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('tunnel log runner strips synthetic API secrets before spawning child', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rc-tunnel-env-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = Object.fromEntries(['PATH','SystemRoot','WINDIR','HOME','USERPROFILE','TEMP','TMP']
    .filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]]));
  env.CONTROL_PLANE_API_KEY = 'SYNTHETIC_ONLY';
  env.OPENAI_API_KEY = 'SYNTHETIC_ONLY';
  const log = path.join(dir, 'relay.log');
  const status = path.join(dir, 'relay.status.json');
  const childCode = 'console.log(JSON.stringify({control:!!process.env.CONTROL_PLANE_API_KEY,openai:!!process.env.OPENAI_API_KEY}))';
  const result = await run([runner, '--log-file', log, '--status-file', status, '--',
    process.execPath, '-e', childCode], { env });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(log, 'utf8')), { control: false, openai: false });
});

test('tunnel log runner rotates without restarting child and preserves the complete stream', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rc-tunnel-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'tunnel-default.log');
  const status = path.join(dir, 'tunnel-default.log.rotation.json');
  const pidFile = path.join(dir, 'child.pid');
  const chunks = 14, chunkBytes = 65536, maxBytes = 262144, maxFiles = 5;

  const result = await run([
    runner,
    '--log-file', log,
    '--status-file', status,
    '--max-bytes', String(maxBytes),
    '--max-files', String(maxFiles),
    '--',
    process.execPath, fixture, pidFile, String(chunks), String(chunkBytes)
  ]);

  assert.equal(result.code, 0, result.stderr);
  const childPid = Number((await readFile(pidFile, 'utf8')).trim());
  assert.ok(Number.isSafeInteger(childPid) && childPid > 0);

  const state = JSON.parse(await readFile(status, 'utf8'));
  assert.equal(state.active, false);
  assert.equal(state.childPid, childPid);
  assert.equal(state.maxBytes, maxBytes);
  assert.equal(state.maxFiles, maxFiles);
  assert.ok(state.rotations >= 3, 'fixture must force multiple live rotations');
  assert.ok(state.archivedFiles <= maxFiles);
  assert.ok(state.currentBytes <= maxBytes);
  assert.equal(state.terminalReason, 'CHILD_EXIT');
  assert.equal(state.errorCode, null);
  assert.ok(!JSON.stringify(state).includes('CONTROL_PLANE_API_KEY'));

  const archiveNames = (await readdir(dir))
    .filter(name => /^tunnel-default[.]log[.]\d+[.]gz$/.test(name))
    .sort((a, b) => Number(b.match(/[.](\d+)[.]gz$/)[1]) - Number(a.match(/[.](\d+)[.]gz$/)[1]));
  assert.ok(archiveNames.length >= 3);
  const parts = [];
  for (const name of archiveNames) parts.push(gunzipSync(await readFile(path.join(dir, name))));
  parts.push(await readFile(log));
  const actual = Buffer.concat(parts);

  assertMergedPipeBytes(actual, { chunks, chunkBytes });
});

test('merged stdout/stderr contract accepts cross-pipe delivery reordering but rejects loss', () => {
  const chunks = 6, chunkBytes = 8;
  const marker = Buffer.from('TUNNEL_CHILD_DONE\n');
  const block = i => Buffer.alloc(chunkBytes, 65 + i);
  const reordered = Buffer.concat([block(0), block(1), block(2), block(3), block(5), marker, block(4)]);
  assertMergedPipeBytes(reordered, { chunks, chunkBytes, marker });

  const lost = Buffer.from(reordered.subarray(1));
  assert.throws(
    () => assertMergedPipeBytes(lost, { chunks, chunkBytes, marker }),
    error => error.code === 'ERR_ASSERTION'
  );
});

test('tunnel log runner bounds and archives an oversized legacy current log before child startup', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rc-tunnel-log-legacy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'tunnel-default.log');
  const status = path.join(dir, 'tunnel-default.log.rotation.json');
  const pidFile = path.join(dir, 'child.pid');
  const maxBytes = 262144;
  const legacy = Buffer.alloc(maxBytes * 2, 0x4c);
  fs.writeFileSync(log, legacy);

  const result = await run([
    runner, '--log-file', log, '--status-file', status,
    '--max-bytes', String(maxBytes), '--max-files', '2', '--',
    process.execPath, fixture, pidFile, '1', '1024'
  ]);
  assert.equal(result.code, 0, result.stderr);
  const archived = gunzipSync(await readFile(log + '.1.gz'));
  assert.equal(archived.length, maxBytes);
  assertBytesEqual(archived, legacy.subarray(legacy.length - maxBytes), 'only the bounded recent diagnostic tail is retained from legacy oversize logs');
  const state = JSON.parse(await readFile(status, 'utf8'));
  assert.ok(state.rotations >= 1);
  assert.ok(state.archivedFiles <= 2);
});

test('binary failure diagnostics stay bounded while rejecting a one-byte mutation', () => {
  const expected=Buffer.alloc(1048576,65),actual=Buffer.from(expected);actual[524288]=66;
  assert.throws(()=>assertBytesEqual(actual,expected,'injected mismatch'),error=>error.code==='ERR_ASSERTION'&&error.message.length<512&&JSON.parse(error.message).firstMismatch===524288);
  assertBytesEqual(expected,Buffer.from(expected),'identical');
});
