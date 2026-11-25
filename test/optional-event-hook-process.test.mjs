import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createOptionalEventHook } from '../src/optional-event-hook.mjs';

async function until(check) {
  for (let i = 0; i < 80; i++) {
    if (check()) return;
    await delay(40);
  }
  assert.fail('fixture child failed to finish before bounded deadline');
}

test('real private adapter child receives only opted-in bounded outcome and remains uninstallable', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rc-relay-process-'));
  const script = path.join(dir, 'synthetic-observer.mjs');
  const receipt = path.join(dir, 'receipt.json');
  writeFileSync(script, [
    "import {writeFileSync} from 'node:fs';",
    "let body='';",
    "for await (const chunk of process.stdin) { body += chunk.toString(); if(body.length>2048)process.exit(2); }",
    "writeFileSync(new URL('./receipt.json',import.meta.url),body,'utf8');"
  ].join('\n'));
  const sha = createHash('sha256').update(readFileSync(script)).digest('hex');
  const config = { enabled: true, extensionId: 'test-owner-opt-in', adapterPath: script, adapterSha256: sha };
  try {
    const disabled = createOptionalEventHook({ ...config, enabled: false });
    assert.equal(disabled.emitTool('workflow_create'), false);
    assert.equal(existsSync(receipt), false);
    const live = createOptionalEventHook(config);
    assert.equal(live.status().ready, true);
    assert.equal(live.emitTool('workflow_checkpoint', { failed: true, project: 'must-not-leak' }), true);
    await until(() => existsSync(receipt) && live.status().relayProcessExitedZero === 1);
    const got = JSON.parse(readFileSync(receipt, 'utf8'));
    assert.deepEqual(Object.keys(got).sort(), ['extensionId','failed','kind','schemaVersion','sessionId','tool']);
    assert.equal(got.schemaVersion, 1);
    assert.equal(got.tool, 'workflow_checkpoint');
    assert.equal(got.failed, true);
    assert.equal(got.extensionId, 'test-owner-opt-in');
    assert.match(got.sessionId, /^[0-9a-f-]{36}$/i);
    assert.ok(!JSON.stringify(got).includes('must-not-leak'));
    assert.equal(live.status().deliveryConfirmed, false);
    appendFileSync(script, '\n// changed script');
    assert.equal(live.status().ready, false);
    assert.equal(live.emitTool('workflow_resume'), false);
    rmSync(script);
    assert.equal(createOptionalEventHook(config).status().ready, false);
    assert.equal(existsSync(receipt), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
