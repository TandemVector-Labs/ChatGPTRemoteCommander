import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {verifyLinuxPrivateProfileBackup} from '../packaging/unified/migration-preflight.mjs';

test('recovery selector rejects dotdot escape and aliases before filesystem inspection', {
  skip: process.platform !== 'linux'
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-recovery-path-boundary-'));
  const home = path.join(root, 'owner');
  const outside = path.join(root, 'outside');
  const inside = path.join(home, 'valid');
  const original = fs.realpathSync;
  try {
    fs.mkdirSync(home, {mode: 0o700});
    fs.mkdirSync(outside, {mode: 0o700});
    fs.mkdirSync(inside, {mode: 0o700});
    const candidates = [
      home + path.sep + '..' + path.sep + 'outside',
      home + path.sep + 'valid' + path.sep + '..' + path.sep + 'valid',
      outside
    ];
    for (const recoveryDir of candidates) {
      let probes = 0;
      fs.realpathSync = function (...args) { probes++; return original.apply(this, args); };
      const result = verifyLinuxPrivateProfileBackup({
        home, ownerUid: process.getuid(), profileName: 'fixture', recoveryDir
      });
      assert.equal(result, false, 'unsafe backup selector must fail closed');
      assert.equal(probes, 0, 'unsafe selector reached a filesystem lookup: ' + recoveryDir);
    }
    let validProbes = 0;
    fs.realpathSync = function (...args) { validProbes++; return original.apply(this, args); };
    assert.equal(verifyLinuxPrivateProfileBackup({
      home, ownerUid: process.getuid(), profileName: 'fixture', recoveryDir: inside
    }), false, 'missing genuine signed backup receipt must fail');
    assert.ok(validProbes > 0, 'legitimate descendant should still reach bounded inspection');
  } finally {
    fs.realpathSync = original;
    fs.rmSync(root, {recursive: true, force: true});
  }
});
