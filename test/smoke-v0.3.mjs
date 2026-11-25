import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import {
  canonicalizeRoots, isWithin, safeExistingPath, safeWritablePath,
  validateCommandArgs, validateProgram
} from '../src/security-v0.3.mjs';
import {
  listDirectory, readText, runProjectCommand, writeText
} from '../src/tools-v0.3.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'rc-v03-smoke-'));
const alias = root + '-alias';
const outsideRoot = root + '-outside';
try {
const roots = await canonicalizeRoots([root]);
const ctx = {
  roots,
  config: {
    maxReadBytes: 1024 * 1024, maxWriteBytes: 1024 * 1024,
    maxCommandMs: 10000, allowedPrograms: ['git', 'node']
  },
  auditLog: path.join(root, 'audit.jsonl')
};

assert.equal(isWithin(path.join(root, 'a.txt'), roots), true);
assert.equal(isWithin(path.resolve(root, '..', 'escape.txt'), roots), false);

// Real Windows Junction / POSIX symlink roots retain their configured alias
// for lexical checks, then enforce the canonical resolved boundary.
await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
const aliasRoots = await canonicalizeRoots([alias]);
assert.equal(isWithin(path.join(alias, 'alias-child.txt'), aliasRoots), true);
assert.equal(isWithin(path.resolve(alias, '..', 'outside.txt'), aliasRoots), false);
const aliasWritable = await safeWritablePath(path.join(alias, 'alias-created.txt'), aliasRoots, alias);
assert.equal(aliasWritable, path.join(alias, 'alias-created.txt'));
await writeFile(path.join(root, 'alias-existing.txt'), 'inside', 'utf8');
assert.equal(
  await safeExistingPath(path.join(alias, 'alias-existing.txt'), aliasRoots, alias),
  path.join(await realpath(root), 'alias-existing.txt')
);
await mkdir(outsideRoot, { recursive: true });
await writeFile(path.join(outsideRoot, 'outside.txt'), 'outside', 'utf8');
await symlink(outsideRoot, path.join(alias, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
await assert.rejects(
  safeExistingPath(path.join(alias, 'escape', 'outside.txt'), aliasRoots, alias),
  /resolved path escapes allowed roots/
);
await assert.rejects(
  safeWritablePath(path.join(alias, 'escape', 'new.txt'), aliasRoots, alias),
  /parent path escapes allowed roots/
);
assert.throws(() => validateProgram('not-allowed', ['git']), /not allowed/);
assert.throws(() => validateProgram('C:\\temp\\git.exe', ['git']), /bare executable name/);
assert.throws(() => validateCommandArgs('node', ['--eval=1+1'], root, roots), /eval\/print/);
const outside = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc/passwd';
assert.throws(
  () => validateCommandArgs('git', [outside], root, roots),
  /outside allowed roots/
);
const writable = await safeWritablePath(path.join(root, 'a.txt'), roots, root);
assert.equal(writable, path.join(root, 'a.txt'));

let result = await writeText(ctx, { path: 'a.txt', content: 'alpha', mode: 'overwrite' });
assert.equal(result.beforeSha256, null);
assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'alpha');
const firstHash = result.sha256;
result = await writeText(ctx, {
  path: 'a.txt', content: 'beta', mode: 'overwrite', expectedSha256: firstHash
});
assert.ok(result.backupPath);
assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'beta');
assert.equal(await readFile(result.backupPath, 'utf8'), 'alpha');

const read = await readText(ctx, { path: 'a.txt' });
assert.equal(read.text, 'beta');
const listing = await listDirectory(ctx, { path: '.', depth: 1, maxEntries: 20 });
assert.ok(listing.entries.some((entry) => entry.path === 'a.txt'));
const command = await runProjectCommand(ctx, {
  program: 'node', args: ['--version'], cwd: root, timeoutMs: 5000
});
assert.equal(command.exitCode, 0);
assert.match(command.stdout, /^v\d+/);

console.log('SMOKE_V03_PASS');
} finally {
  await rm(alias, { recursive: true, force: true });
  await rm(outsideRoot, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
}
