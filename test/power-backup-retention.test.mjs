import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { mkdtemp, readFile, readdir, realpath, rm, truncate, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { powerStatus, writeAnyFile } from '../src/power-tools-v0.3.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');

function ctx(root, backups, keep = 8) {
  return {
    roots: [root],
    accessStatus: {configuredTier:'FULL_POWER',effectiveTier:'FULL_POWER',hostExecution:{mode:'FULL_HOST_USER',hostFilesystem:true,shellAvailable:true},nativeRoot:{nonRootTokenVerified:true},nativeAdmin:{nonElevatedTokenVerified:false}},
    config: {
      capabilityProfile: {tier:'FULL_POWER',explicitlyAuthorized:true,disabledCapabilities:[]},
      powerMode: {
        enabled: true,
        fullFilesystem: true,
        backupRoot: backups,
        backupRetentionSnapshots: keep,
        maxFileBytes: 8 * 1024 * 1024
      }
    }
  };
}

async function treeBytes(root) {
  let total = 0;
  if (!fs.existsSync(root)) return 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else total += (await fs.promises.stat(p)).size;
    }
  }
  return total;
}

test('Power Mode append recovery is compact, bounded and rollback-verifiable', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rc-backup-retention-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backups = path.join(root, 'backups');
  const target = path.join(root, 'large.log');
  const initial = Buffer.alloc(2 * 1024 * 1024, 0x61);
  await writeFile(target, initial);
  const c = ctx(root, backups, 8);
  const status = await powerStatus(c);
  assert.equal(status.backupPolicy.retainedSnapshotsPerTarget, 8);
  assert.equal(status.backupPolicy.appendRecovery, 'verified-truncate-journal');

  let expected = initial;
  let latest;
  for (let i = 0; i < 24; i += 1) {
    const chunk = Buffer.alloc(64 * 1024, 0x41 + (i % 20));
    latest = await writeAnyFile(c, {
      path: target,
      content: chunk.toString('base64'),
      encoding: 'base64',
      mode: 'append',
      expectedSha256: sha(expected)
    });
    expected = Buffer.concat([expected, chunk]);
    assert.equal(latest.backupKind, 'append-truncate-recovery');
    assert.equal(latest.sha256, sha(expected));
  }

  const containers = await readdir(backups, { withFileTypes: true });
  assert.ok(containers.filter(e => e.isDirectory()).length <= 8, 'per-target retention must prune older recovery points');
  assert.ok(await treeBytes(backups) < 128 * 1024, 'append recovery metadata must stay tiny instead of copying the growing file');

  const journal = JSON.parse(await readFile(latest.backupPath, 'utf8'));
  assert.equal(journal.kind, 'append-truncate-recovery');
  assert.equal(journal.target, await realpath(target));
  assert.equal(journal.beforeSha256, latest.beforeSha256);
  await truncate(target, journal.beforeBytes);
  const rolledBack = await readFile(target);
  assert.equal(sha(rolledBack), journal.beforeSha256, 'truncate journal must deterministically restore the exact pre-append bytes');
});

test('Power Mode file snapshots retain only the configured newest rollback copies', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rc-backup-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backups = path.join(root, 'backups');
  const target = path.join(root, 'state.txt');
  await writeFile(target, 'v0');
  const c = ctx(root, backups, 4);
  let expected = Buffer.from('v0');
  for (let i = 1; i <= 12; i += 1) {
    const result = await writeAnyFile(c, {
      path: target,
      content: `v${i}`,
      mode: 'overwrite',
      expectedSha256: sha(expected)
    });
    assert.equal(result.backupKind, 'snapshot');
    const backup = await readFile(result.backupPath);
    assert.equal(sha(backup), sha(expected), 'new rollback snapshot must be verified before retention pruning');
    expected = Buffer.from(`v${i}`);
  }
  const containers = (await readdir(backups, { withFileTypes: true })).filter(e => e.isDirectory());
  assert.equal(containers.length, 4);
});
