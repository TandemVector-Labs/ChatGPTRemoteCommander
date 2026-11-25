import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile, rm } from 'node:fs/promises';
import { copyPath, movePath, readAnyFile, writeAnyFile } from '../src/power-tools-v0.3.mjs';
import { withFullPowerAccess } from './helpers/access-mode-fixtures.mjs';
import { withPathLocks, lockStats } from '../src/locks.mjs';

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'rc-fs-root-')));
const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'rc-fs-outside-')));
const backups = await realpath(await mkdtemp(path.join(os.tmpdir(), 'rc-fs-backup-')));
const ctx = {
  roots: [root],
  config: {
    powerMode: {
      enabled: true,
      fullFilesystem: false,
      allowShell: false,
      allowProcessControl: false,
      allowPermanentDelete: false,
      backupRoot: backups,
      maxFileBytes: 1024 * 1024
    }
  }
};
withFullPowerAccess(ctx);

try {
  await writeFile(path.join(root, 'src.txt'), 'SOURCE');
  await writeFile(path.join(root, 'dst.txt'), 'DEST');
  await mkdir(path.join(root, 'dir'), { recursive: true });
  await writeFile(path.join(root, 'dir', 'a.txt'), 'A');

  await assert.rejects(
    () => copyPath(ctx, { source: path.join(root, 'src.txt'), destination: path.join(root, 'src.txt'), overwrite: true }),
    /relationship is unsafe/
  );
  await assert.rejects(
    () => copyPath(ctx, { source: path.join(root, 'dir'), destination: path.join(root, 'dir', 'nested'), overwrite: true }),
    /relationship is unsafe/
  );
  await assert.rejects(
    () => movePath(ctx, { source: path.join(root, 'dir'), destination: root, overwrite: true }),
    /relationship is unsafe/
  );

  const copied = await copyPath(ctx, { source: path.join(root, 'src.txt'), destination: path.join(root, 'dst.txt'), overwrite: true });
  assert.equal(await readFile(path.join(root, 'dst.txt'), 'utf8'), 'SOURCE');
  assert.equal(copied.transactional, true);
  assert.ok(copied.backupPath);

  let symlinkCreated = false;
  try {
    await symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    symlinkCreated = true;
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) throw error;
  }
  if (symlinkCreated) {
    await writeFile(path.join(outside, 'secret.txt'), 'OUTSIDE');
    await assert.rejects(() => readAnyFile(ctx, { path: path.join(root, 'escape', 'secret.txt') }), /escapes allowed roots/);
    await assert.rejects(() => writeAnyFile(ctx, { path: path.join(root, 'escape', 'new.txt'), content: 'NO' }), /escapes allowed roots/);

    const fullCtx = {
      ...ctx,
      config: {
        capabilityProfile: {
          tier: 'FULL_POWER', explicitlyAuthorized: true, disabledCapabilities: []
        },
        powerMode: { ...ctx.config.powerMode, fullFilesystem: true }
      }
    };
    await assert.rejects(
      () => copyPath(fullCtx, { source: outside, destination: path.join(root, 'escape'), overwrite: true }),
      /relationship is unsafe|symbolic-link writes are not allowed/
    );
  }

  const events = [];
  let releaseParent;
  const parentHeld = new Promise((resolve) => {
    withPathLocks([path.join(root, 'dir')], async () => {
      events.push('parent-start');
      await new Promise(r => { releaseParent = r; });
      events.push('parent-end');
    }).then(resolve);
  });
  while (!releaseParent) await new Promise(r => setTimeout(r, 1));

  let childStarted = false;
  const child = withPathLocks([path.join(root, 'dir', 'a.txt')], async () => {
    childStarted = true;
    events.push('child');
  });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(childStarted, false);
  assert.equal(lockStats().queued, 1);
  releaseParent();
  await parentHeld;
  await child;
  assert.deepEqual(events, ['parent-start', 'parent-end', 'child']);

  let disjointStarted = false;
  let releaseA;
  const a = withPathLocks([path.join(root, 'A')], async () => {
    await new Promise(r => { releaseA = r; });
  });
  while (!releaseA) await new Promise(r => setTimeout(r, 1));
  const b = withPathLocks([path.join(root, 'B')], async () => { disjointStarted = true; });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(disjointStarted, true);
  releaseA();
  await Promise.all([a, b]);

  console.log('FS_SAFETY_PASS');
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
  await rm(backups, { recursive: true, force: true });
}
