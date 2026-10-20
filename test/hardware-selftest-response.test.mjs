import test from 'node:test';
import assert from 'node:assert/strict';
import {readBoundedHardwareResponse, MAX_HARDWARE_SELFTEST_RESPONSE_BYTES as LIMIT} from '../tools/hardware-selftest-response.mjs';

test('bounded hardware HTTP reads preserve UTF-8 split across stream chunks', async () => {
  const value = '{"status":"پایدار"}';
  const encoded = Buffer.from(value, 'utf8');
  const chunks = [encoded.subarray(0, 12), encoded.subarray(12, 16), encoded.subarray(16)];
  const response = { body: (async function* () { for (const chunk of chunks) yield chunk; })() };
  assert.equal(await readBoundedHardwareResponse(response), value);
});

test('the exact size cap is accepted without truncation', async () => {
  const response = { body: (async function* () { yield Buffer.alloc(LIMIT, 0x61); })() };
  const output = await readBoundedHardwareResponse(response);
  assert.equal(Buffer.byteLength(output), LIMIT);
});

test('oversized response aborts iteration before a third attacker-controlled chunk', async () => {
  let supplied = 0;
  let closed = false;
  const body = (async function* () {
    try {
      supplied++; yield Buffer.alloc(LIMIT - 3);
      supplied++; yield Buffer.alloc(4);
      supplied++; yield Buffer.alloc(100);
    } finally { closed = true; }
  })();
  await assert.rejects(readBoundedHardwareResponse({body}), {code:'SELFTEST_RESPONSE_TOO_LARGE'});
  assert.equal(supplied, 2);
  assert.equal(closed, true);
});

test('missing response body remains an empty response', async () => {
  assert.equal(await readBoundedHardwareResponse({body:null}), '');
});
