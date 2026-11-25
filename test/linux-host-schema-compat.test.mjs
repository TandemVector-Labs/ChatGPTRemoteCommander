import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { powerToolDefinitions, searchFiles } from '../src/power-tools-v0.3.mjs';
import { withFullPowerAccess } from './helpers/access-mode-fixtures.mjs';
import { synchronousCommandInput } from '../src/retry-guard.mjs';

const def = name => powerToolDefinitions.find(x => x.name === name);

test('host compatibility schema stays broad while v0.10.14 runtime stays hard bounded', async () => {
  assert.equal(def('run_shell').inputSchema.properties.timeoutMs.maximum, 30000);
  assert.equal(def('search_files').inputSchema.properties.maxResults.maximum, 1000);
  assert.equal(def('search_files').inputSchema.properties.maxContentBytes.maximum, undefined);
  assert.throws(() => synchronousCommandInput({ timeoutMs: 30000 }), /SYNCHRONOUS_COMMAND_DEADLINE_RISK/);
  assert.equal(synchronousCommandInput({ timeoutMs: 10000 }).timeoutMs, 10000);
  assert.throws(() => synchronousCommandInput({ timeoutMs: 10001 }), /SYNCHRONOUS_COMMAND_DEADLINE_RISK/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-host-compat-'));
  try {
    for (let i = 0; i < 260; i++) fs.writeFileSync(path.join(root, `f-${i}.txt`), 'x');
    const ctx = withFullPowerAccess({ roots: [root], config: { powerMode: { enabled: true, fullFilesystem: true, maxCommandMs: 600000, maxOutputBytes: 2097152 } } });
    const result = await searchFiles(ctx, { path: root, pattern: 'f-', maxResults: 1000, maxContentBytes: 8 * 1024 * 1024, maxDurationMs: 10000 });
    assert.ok(result.count <= 200, `runtime result count escaped 200 clamp: ${result.count}`);
    assert.equal(result.truncated, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
