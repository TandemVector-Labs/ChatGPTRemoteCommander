import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyCompiledCore } from './native-compiled-core-verifier.mjs';

const head = 'a'.repeat(40), tree = 'b'.repeat(40);
const sha256 = s => createHash('sha256').update(s).digest('hex');
function fixture(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-compiled-native-core-'));
  const core = path.join(tmp, 'compiled', 'core');
  const sourceManifest = path.join(tmp, 'source-manifest.json');
  fs.mkdirSync(path.join(core, 'src'), { recursive: true });
  const files = {
    'package.json': '{ "name": "qa" }\n',
    'config.json': '{}\n',
    'src/server-v0.3.mjs': 'export const ok = true;\n'
  };
  for (const [key, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(core, key), content);
  }
  const manifest = { schema: 2, head, tree, count: 3,
    files: Object.fromEntries(Object.entries(files).map(([name, body]) => [name, sha256(body)])) };
  const bytes = JSON.stringify(manifest) + '\n';
  fs.writeFileSync(sourceManifest, bytes);
  fs.writeFileSync(path.join(core, 'source-manifest.json'), bytes);
  try { return fn({ core, coreRoot: core, sourceManifest, expectedCommit: head }); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
test('exact compiled native Core payload and pinned manifest pass', () => fixture(args => {
  const result = verifyCompiledCore(args);
  assert.equal(result.status, 'COMPILED_NATIVE_CORE_HASH_PASS');
  assert.equal(result.files, 3);
  assert.equal(result.publisherSignatureVerified, false);
  assert.equal(result.liveInstallationVerified, false);
}));
test('tampered extracted Core byte fails closed', () => fixture(args => {
  fs.writeFileSync(path.join(args.core, 'src', 'server-v0.3.mjs'), 'changed');
  assert.throws(() => verifyCompiledCore(args), /NATIVE_CORE_SHA256_MISMATCH/);
}));
test('missing and extra compiled Core files fail closed', () => fixture(args => {
  const p = path.join(args.core, 'package.json');
  fs.rmSync(p);
  assert.throws(() => verifyCompiledCore(args), /NATIVE_CORE_MISSING_FILE/);
  fs.writeFileSync(p, '{ "name": "qa" }\n');
  fs.writeFileSync(path.join(args.core, 'extraneous.mjs'), 'leaked');
  assert.throws(() => verifyCompiledCore(args), /NATIVE_CORE_UNLISTED_FILE/);
}));
test('private specialist file names are never accepted', () => fixture(args => {
  fs.writeFileSync(path.join(args.core, 'coucou-private.mjs'), 'unsafe');
  assert.throws(() => verifyCompiledCore(args), /NATIVE_CORE_UNSAFE_EXTRACTED_PATH/);
}));
test('rewritten embedded manifest is refused even if self-consistent', () => fixture(args => {
  const p = path.join(args.core, 'source-manifest.json');
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  m.tree = 'c'.repeat(40);
  fs.writeFileSync(p, JSON.stringify(m));
  assert.throws(() => verifyCompiledCore(args), /NATIVE_CORE_SOURCE_MANIFEST_CHANGED/);
}));
test('wrong PR head is not accepted', () => fixture(args => {
  assert.throws(() => verifyCompiledCore({ ...args, expectedCommit: 'f'.repeat(40) }), /NATIVE_CORE_BAD_MANIFEST/);
}));
test('invalid manifest path traversal is refused', () => fixture(args => {
  const p = path.join(args.core, 'source-manifest.json');
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  m.files['../outside.mjs'] = 'f'.repeat(64);
  m.count++;
  const payload = JSON.stringify(m);
  fs.writeFileSync(p, payload);
  fs.writeFileSync(args.sourceManifest, payload);
  assert.throws(() => verifyCompiledCore(args), /NATIVE_CORE_UNSAFE_MANIFEST_PATH/);
}));

test('hosted Windows extraction forces embedded 7z and not the outer NSIS parser', () => {
  const yaml = fs.readFileSync(new URL('../.github/workflows/unified-installer-pilot.yml', import.meta.url), 'utf8');
  assert.match(yaml, /& \$zipPath x -t7z -y/);
});
