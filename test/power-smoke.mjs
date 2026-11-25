import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, rm } from 'node:fs/promises';
import {
  copyPath, createDirectory, deletePath, fileInfo, movePath,
  powerStatus, readAnyFile, runShell, searchFiles,
  startTerminal, readTerminal, stopTerminal, writeAnyFile
} from '../src/power-tools.mjs';

const root = path.resolve('test', '.tmp-power-root');
const backups = path.resolve('test', '.tmp-power-backups');
await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
await rm(backups, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
await mkdir(root, { recursive: true });
const ctx = {
  roots: [root],
  accessStatus: {configuredTier:'FULL_POWER',effectiveTier:'FULL_POWER',hostExecution:{mode:'FULL_HOST_USER',hostFilesystem:true,shellAvailable:true},nativeRoot:{nonRootTokenVerified:true},nativeAdmin:{nonElevatedTokenVerified:false}},
  config: {
    capabilityProfile: {tier:'FULL_POWER',explicitlyAuthorized:true,disabledCapabilities:[]},
    powerMode: {
      enabled: true, fullFilesystem: true, allowShell: true,
      allowProcessControl: true, allowPermanentDelete: false,
      backupRoot: backups, maxFileBytes: 1024 * 1024,
      maxCommandMs: 10000, maxOutputBytes: 1024 * 1024,
      maxTerminalBufferBytes: 1024 * 1024,
      blockedShellPatterns: ['shutdown', 'Restart-Computer', 'Stop-Computer', 'logoff']
    }
  }
};
assert.equal((await powerStatus(ctx)).enabled, true);
await createDirectory(ctx, { path: path.join(root, 'a', 'b') });
let write = await writeAnyFile(ctx, { path: path.join(root, 'a', 'b', 'x.txt'), content: 'alpha' });
assert.ok(write.sha256);
let read = await readAnyFile(ctx, { path: path.join(root, 'a', 'b', 'x.txt') });
assert.equal(read.content, 'alpha');

const info = await fileInfo(ctx, { path: path.join(root, 'a', 'b', 'x.txt') });
assert.equal(info.isFile, true);
await copyPath(ctx, { source: path.join(root, 'a'), destination: path.join(root, 'copy') });
await movePath(ctx, { source: path.join(root, 'copy', 'b', 'x.txt'), destination: path.join(root, 'moved.txt') });
assert.equal(await readFile(path.join(root, 'moved.txt'), 'utf8'), 'alpha');

const search = await searchFiles(ctx, { path: root, pattern: 'alpha', searchContent: true, depth: 5 });
assert.ok(search.results.some((item) => item.path.endsWith('moved.txt')));

if (process.platform === 'win32') {
  const shell = await runShell(ctx, { command: "Write-Output 'POWER_SHELL_PASS'", cwd: root, timeoutMs: 5000 });
  assert.equal(shell.exitCode, 0);
  assert.match(shell.stdout, /POWER_SHELL_PASS/);
  await assert.rejects(() => runShell(ctx, { command: 'shutdown /s', cwd: root }), /blocked by policy/);

  const term = await startTerminal(ctx, { cwd: root, command: "Write-Output 'TERM_PASS'" });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const termOut = await readTerminal(ctx, { id: term.id });
  assert.match(termOut.stdout, /TERM_PASS/);
  await stopTerminal(ctx, { id: term.id });
} else {
  console.log('POWER_SHELL_SMOKE_SKIP_NON_WINDOWS');
}

const deleted = await deletePath(ctx, { path: path.join(root, 'moved.txt') });
assert.ok(deleted.backupPath);
await assert.rejects(() => deletePath(ctx, { path: path.join(root, 'a'), permanent: true }), /permanent delete is disabled/);
console.log('POWER_SMOKE_PASS');
await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
await rm(backups, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
