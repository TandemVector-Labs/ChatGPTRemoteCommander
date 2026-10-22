import path from 'node:path';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { execFile as rawExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const execFile = promisify(rawExecFile);
const PIPE = /^rcgui-[0-9a-f]{24}$/;
const OWNER_SID = /^S-1-5-21-(?:[0-9]{1,11}-){3}[0-9]{1,11}$/;
const HEX_HASH = /^[a-fA-F0-9]{64}$/;
const MAX_DESCRIPTOR = 4096;
const MAX_DLL_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT = 4096;
const TIMEOUT = 7000;

export function createWindowsOwnerGuiStatusProvider({
  descriptorPath = process.env.RC_OWNER_GUI_READONLY_DESCRIPTOR,
  dllPath,
  expectedDllSha256 = null,
  programFiles = process.env.ProgramFiles || 'C:\\Program Files',
  dotnetExe = path.win32.join(programFiles, 'dotnet', 'dotnet.exe'),
  run = execFile,
  read = readFile,
  stat = lstat,
  canonical = realpath,
  platform = process.platform
} = {}) {
  // A SYSTEM process must NEVER load a DLL compiled in a user-writable
  // development checkout. Only an installer-pinned hash under Program Files
  // is eligible. Until a trusted installer supplies that hash, this feature
  // remains unavailable even when the status-only flag is enabled.
  if (platform !== 'win32' || !descriptorPath || !dllPath
      || typeof expectedDllSha256 !== 'string' || !HEX_HASH.test(expectedDllSha256)) return null;
  const trustedDir = path.win32.join(programFiles, 'TandemVector-Labs', 'RemoteCommander');
  if (path.win32.normalize(path.win32.dirname(dllPath)).toLowerCase() !==
      path.win32.normalize(trustedDir).toLowerCase()) return null;
  return async function ownerSessionStatus() {
    try {
      if (!path.win32.isAbsolute(descriptorPath) || !path.win32.isAbsolute(dllPath)
          || !path.win32.isAbsolute(dotnetExe)) return null;
      const [info, binaryInfo] = await Promise.all([stat(descriptorPath), stat(dllPath)]);
      if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > MAX_DESCRIPTOR) return null;
      if (!binaryInfo.isFile() || binaryInfo.isSymbolicLink()
          || binaryInfo.size < 1 || binaryInfo.size > MAX_DLL_BYTES) return null;
      const [resolvedMeta, resolvedDll] = await Promise.all([
        canonical(descriptorPath), canonical(dllPath)
      ]);
      if (path.win32.normalize(resolvedMeta).toLowerCase() !==
          path.win32.normalize(descriptorPath).toLowerCase() ||
          path.win32.normalize(resolvedDll).toLowerCase() !==
          path.win32.normalize(dllPath).toLowerCase()) return null;
      const [data, bytes] = await Promise.all([read(descriptorPath, 'utf8'), read(dllPath)]);
      if (typeof data !== 'string' || Buffer.byteLength(data) > MAX_DESCRIPTOR ||
          !Buffer.isBuffer(bytes) || bytes.length !== binaryInfo.size) return null;
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== expectedDllSha256.toLowerCase()) return null;
      const v = JSON.parse(data);
      if (!v || Object.keys(v).sort().join('|') !== 'keyFile|ownerSid|pipe|schema'
          || v.schema !== 1 || typeof v.pipe !== 'string' || !PIPE.test(v.pipe)
          || typeof v.ownerSid !== 'string' || !OWNER_SID.test(v.ownerSid)
          || typeof v.keyFile !== 'string' || !path.win32.isAbsolute(v.keyFile)) return null;
      const args = [dllPath, 'probe', '--pipe', v.pipe, '--key-file', v.keyFile, '--owner-sid', v.ownerSid];
      const { stdout } = await run(dotnetExe, args, {
        timeout: TIMEOUT, maxBuffer: MAX_OUTPUT, windowsHide: true
      });
      if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > MAX_OUTPUT) return null;
      // The .NET binary verified the MAC; the GUI controller still separately
      // validates the closed-schema status and refuses Session 0 input leases.
      return JSON.parse(stdout);
    } catch {
      return null;
    }
  };
}
