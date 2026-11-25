#!/usr/bin/env node
// CI only: prove bytes shipped inside a native installer match the
// already prepared, exact-commit Core manifest; never execute the installer.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SHA40 = /^[0-9a-f]{40}$/;
const SHA64 = /^[0-9a-f]{64}$/;
const PRIVATE = /coucou|personalization-project-skills|mmz-scientific-skills|private-extensions|research-domain-agents|(^|\/)extensions(\/|$)/i;
const check = (condition, reason) => { if (!condition) throw Error(reason); };

function trustedRegularFile(file, maxSize) {
  const stat = fs.lstatSync(file);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 &&
    stat.size > 0 && stat.size <= maxSize, 'NATIVE_CORE_UNTRUSTED_FILE');
  return fs.readFileSync(file);
}

function safeRelative(file) {
  return typeof file === 'string' && file.length > 0 && file.length <= 260 &&
    !file.includes('\\') && !file.startsWith('/') &&
    file.split('/').every(bit => bit !== '' && bit !== '.' && bit !== '..' &&
      /^[A-Za-z0-9._+@-]+$/.test(bit)) && !PRIVATE.test(file);
}

export function verifyCompiledCore({ coreRoot, sourceManifest, expectedCommit }) {
  check(typeof coreRoot === 'string' && path.isAbsolute(coreRoot) &&
    typeof sourceManifest === 'string' && path.isAbsolute(sourceManifest) &&
    SHA40.test(expectedCommit), 'NATIVE_CORE_BAD_ARGUMENTS');
  const root = path.resolve(coreRoot);
  const rootStat = fs.lstatSync(root);
  check(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'NATIVE_CORE_BAD_ROOT');

  const expectedBytes = trustedRegularFile(sourceManifest, 1024 * 1024);
  const actualBytes = trustedRegularFile(path.join(root, 'source-manifest.json'), 1024 * 1024);
  check(actualBytes.equals(expectedBytes), 'NATIVE_CORE_SOURCE_MANIFEST_CHANGED');
  const manifest = JSON.parse(actualBytes.toString('utf8'));
  check(manifest?.schema === 2 && manifest.head === expectedCommit &&
    SHA40.test(manifest.tree) && Number.isSafeInteger(manifest.count) &&
    manifest.count > 0 && manifest.count <= 10000 &&
    manifest.files && typeof manifest.files === 'object' &&
    !Array.isArray(manifest.files), 'NATIVE_CORE_BAD_MANIFEST');
  const expected = new Map(Object.entries(manifest.files));
  check(expected.size === manifest.count, 'NATIVE_CORE_BAD_COUNT');
  const caseFolded = new Set();
  for (const [name, sha] of expected) {
    check(safeRelative(name) && SHA64.test(sha), 'NATIVE_CORE_UNSAFE_MANIFEST_PATH');
    const key = name.toLowerCase();
    check(!caseFolded.has(key), 'NATIVE_CORE_CASE_COLLISION');
    caseFolded.add(key);
  }
  for (const required of ['package.json','config.json','src/server-v0.3.mjs']) {
    check(expected.has(required), 'NATIVE_CORE_REQUIRED_SOURCE_MISSING');
  }

  let checked = 0;
  const seen = new Set();
  function inspect(directory, prefix = '') {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix + entry.name;
      check(safeRelative(relative), 'NATIVE_CORE_UNSAFE_EXTRACTED_PATH');
      const full = path.join(directory, entry.name);
      const stat = fs.lstatSync(full);
      check(!stat.isSymbolicLink(), 'NATIVE_CORE_SYMLINK_REFUSED');
      if (entry.isDirectory()) {
        check(stat.isDirectory(), 'NATIVE_CORE_UNEXPECTED_DIRECTORY');
        inspect(full, relative + '/');
      } else {
        check(entry.isFile() && stat.isFile() && stat.nlink === 1,
          'NATIVE_CORE_UNEXPECTED_FILE_TYPE');
        if (relative === 'source-manifest.json' && prefix === '') continue;
        check(expected.has(relative), 'NATIVE_CORE_UNLISTED_FILE');
        check(!seen.has(relative), 'NATIVE_CORE_DUPLICATE_FILE');
        const hash = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
        check(hash === expected.get(relative), 'NATIVE_CORE_SHA256_MISMATCH');
        seen.add(relative);
        checked++;
      }
    }
  }
  inspect(root);
  check(checked === manifest.count, 'NATIVE_CORE_MISSING_FILE');
  return Object.freeze({ status: 'COMPILED_NATIVE_CORE_HASH_PASS',
    commit: manifest.head, tree: manifest.tree, files: checked,
    publisherSignatureVerified: false, liveInstallationVerified: false });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = new Map();
    for (let i = 0; i < args.length; i += 2) {
      check(i + 1 < args.length &&
        ['--core-root','--source-manifest','--expected-commit'].includes(args[i]) &&
        !options.has(args[i]), 'NATIVE_CORE_CLI_ARGUMENTS');
      options.set(args[i], args[i + 1]);
    }
    check(options.size === 3, 'NATIVE_CORE_CLI_REQUIRED_ARGUMENTS');
    console.log(JSON.stringify(verifyCompiledCore({
      coreRoot: options.get('--core-root'),
      sourceManifest: options.get('--source-manifest'),
      expectedCommit: options.get('--expected-commit')
    })));
  } catch (error) {
    console.error(JSON.stringify({ status: 'COMPILED_NATIVE_CORE_HASH_FAILED',
      reason: String(error?.message ?? error) }));
    process.exitCode = 2;
  }
}
