import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import path from 'node:path';

const PROFILE = /^[A-Za-z0-9_-]{1,64}$/;
const PREFIX = 'rc-native-grant-';

/**
 * Read a fixed, binary 32-byte secret from systemd LoadCredentialEncrypted.
 * Never pass this secret as MCP input, a process argument, JSON config,
 * an environment variable, or a log message. The only runtime selector
 * is the *trusted* configured profile ID.
 *
 * UID-sharing owner sessions are NOT independent security principals.
 */
export async function loadNativeGrantCredential(profileId, {
  platform = process.platform,
  credentialsDirectory = process.env.CREDENTIALS_DIRECTORY
} = {}) {
  if (platform !== 'linux') throw new Error('NATIVE_GRANT_LINUX_ONLY');
  if (typeof profileId !== 'string' || !PROFILE.test(profileId)) {
    throw new Error('NATIVE_GRANT_PROFILE_INVALID');
  }
  if (typeof credentialsDirectory !== 'string' ||
      !path.isAbsolute(credentialsDirectory) ||
      credentialsDirectory.length > 4096) {
    throw new Error('NATIVE_GRANT_SERVICE_CREDENTIALS_REQUIRED');
  }
  let dir;
  try { dir = await lstat(credentialsDirectory); }
  catch { throw new Error('NATIVE_GRANT_SERVICE_CREDENTIALS_UNAVAILABLE'); }
  if (!dir.isDirectory() || dir.isSymbolicLink()) {
    throw new Error('NATIVE_GRANT_CREDENTIAL_DIRECTORY_UNTRUSTED');
  }
  const filename = path.join(credentialsDirectory, PREFIX + profileId);
  let handle;
  try { handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch { throw new Error('NATIVE_GRANT_CREDENTIAL_NOT_DELIVERED'); }
  const buffer = Buffer.alloc(33);
  try {
    const state = await handle.stat();
    if (!state.isFile() || state.nlink !== 1 || state.size !== 32) {
      throw new Error('NATIVE_GRANT_CREDENTIAL_INVALID_SIZE_OR_TYPE');
    }
    const { bytesRead } = await handle.read(buffer, 0, 33, 0);
    if (bytesRead !== 32) throw new Error('NATIVE_GRANT_CREDENTIAL_INVALID_SIZE_OR_TYPE');
    return Buffer.from(buffer.subarray(0, 32));
  } finally {
    buffer.fill(0);
    await handle.close();
  }
}
