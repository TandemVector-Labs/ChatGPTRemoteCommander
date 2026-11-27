import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, realpath, open } from 'node:fs/promises';

const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const sameFile = (a, b) => sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
function fail(code) { throw Object.assign(new Error(code), { code }); }

/** Inspect without following aliases; recheck the snapshot before each mutation.
 * This is a filesystem precondition, not isolation from another local OS actor.
 */
export async function guardFileWrite(target, expected) {
  return inspectFilePath(target, expected);
}

// A Windows startup path may use a genuine NTFS 8.3 name (e.g. RUNNER~1).
// Admit it only for Host reads, and only when every canonical component
// has the same non-reparse identity as the inspected original component.
async function verifyWindowsShortNames(original, canonical, records) {
  const a = path.parse(original), b = path.parse(canonical);
  if (key(a.root) !== key(b.root)) fail('FILE_WRITE_ALIAS');
  const from = original.slice(a.root.length).split(path.sep).filter(Boolean);
  const to = canonical.slice(b.root.length).split(path.sep).filter(Boolean);
  if (from.length !== to.length || records.length !== from.length + 1) fail('FILE_WRITE_ALIAS');
  let cursor = b.root;
  for (let i = -1; i < to.length; i++) {
    if (i >= 0) {
      if (from[i].toLowerCase() !== to[i].toLowerCase()
          && !/^[^\\/:*?"<>|~. ]{1,6}~[0-9]+(?:\.[^\\/:*?"<>|~. ]{1,3})?$/.test(from[i])) {
        fail('FILE_WRITE_ALIAS');
      }
      cursor = path.join(cursor, to[i]);
    }
    const info = await lstat(cursor, { bigint: true });
    if (info.isSymbolicLink() || !sameIdentity(records[i + 1].info, info)) fail('FILE_WRITE_ALIAS');
  }
}
async function inspectFilePath(target, expected, allowWindowsShortNames = false) {
  target = path.resolve(target);
  // An absent leaf has no file identity. Its snapshot must still name this exact target.
  if (expected !== undefined && expected?.target !== target) fail('FILE_WRITE_TARGET_CHANGED');
  const parsed = path.parse(target);
  const parts = target.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const ancestors = [];
  let cursor = parsed.root, leaf = null, missing = false, deepestExisting = null;
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) cursor = path.join(cursor, parts[index]);
    const last = index === parts.length - 1;
    let info;
    try { info = await lstat(cursor, { bigint: true }); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing = true;
      break;
    }
    if (info.isSymbolicLink()) fail('FILE_WRITE_ALIAS');
    if (last) {
      if (!info.isFile()) fail('FILE_WRITE_NOT_REGULAR');
      if (info.nlink !== 1n) fail('FILE_WRITE_HARDLINK');
      leaf = info;
    } else {
      if (!info.isDirectory()) fail('FILE_WRITE_PARENT_NOT_DIRECTORY');
      ancestors.push({ path: cursor, info });
    }
    deepestExisting = cursor;
  }
  // One full canonical path verifies the complete ancestor chain. Resolving
  // each ancestor separately can require unrelated directory permissions that
  // the caller does not have, even when this exact descendant is authorized.
  // Never ignore canonicalization errors, and never canonicalize a missing leaf.
  if (!deepestExisting) fail('FILE_WRITE_PARENT_NOT_DIRECTORY');
  const canonical = await realpath(deepestExisting);
  if (key(canonical) !== key(deepestExisting)) {
    if (process.platform !== 'win32' || !allowWindowsShortNames) fail('FILE_WRITE_ALIAS');
    await verifyWindowsShortNames(deepestExisting, canonical,
      leaf ? [...ancestors, { path: deepestExisting, info: leaf }] : ancestors);
  }
  if (expected !== undefined) {
    if ((expected.leaf === null) !== (leaf === null) || (leaf !== null && !sameFile(expected.leaf, leaf))) fail('FILE_WRITE_TARGET_CHANGED');
    for (const before of expected.ancestors) {
      const now = ancestors.find(item => key(item.path) === key(before.path));
      if (!now || !sameIdentity(before.info, now.info)) fail('FILE_WRITE_TARGET_CHANGED');
    }
  }
  return { target, leaf: missing ? null : leaf, ancestors };
}

// Host config is control-plane input, including the owner-selected executable.
// Bind the bytes to one regular, single-link file and its inspected ancestry.
// This is an identity/size precondition, not proof of OS owner/ACL custody.
const MAX_HOST_CONFIG_BYTES = 8 * 1024 * 1024;
async function readHostConfigPath(value, { optional = false } = {}) {
  const configPath = path.resolve(value);
  const inspect = async expected => {
    try { return await inspectFilePath(configPath, expected, true); }
    catch { fail('HOST_CONFIG_PATH_UNTRUSTED'); }
  };
  const snapshot = await inspect();
  if (!snapshot.leaf) {
    if (optional) return null;
    fail('HOST_CONFIG_NOT_FOUND');
  }
  if (snapshot.leaf.size > BigInt(MAX_HOST_CONFIG_BYTES)) fail('HOST_CONFIG_TOO_LARGE');
  let handle;
  try {
    // NONBLOCK prevents a raced FIFO from blocking open on platforms that
    // support it. NOFOLLOW and the identity checks reject leaf/ancestor drift.
    handle = await open(configPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
      | (constants.O_NONBLOCK ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameFile(snapshot.leaf, opened)) {
      fail('HOST_CONFIG_CHANGED');
    }
    await inspect(snapshot);
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || after.nlink !== 1n || !sameFile(opened, after)
        || BigInt(offset) !== opened.size) fail('HOST_CONFIG_CHANGED');
    await inspect(snapshot);
    return { configPath, configRaw: bytes.subarray(0, offset).toString('utf8') };
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('HOST_CONFIG_')) throw error;
    // A file observed and then lost or denied is not an absent optional file.
    fail('HOST_CONFIG_READ_FAILED');
  } finally { if (handle) await handle.close(); }
}

export async function readBoundHostConfiguration({ explicitConfigPath, defaultConfigPath, localConfigPath }) {
  if (explicitConfigPath) return readHostConfigPath(explicitConfigPath);
  // Only a missing optional local file permits fallback, never an alias,
  // read failure, nonregular target, or replacement after initial inspection.
  return await readHostConfigPath(localConfigPath, { optional: true })
    ?? await readHostConfigPath(defaultConfigPath);
}
