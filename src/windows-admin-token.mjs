import { execFile } from 'node:child_process';

const MACHINE_PWSH = String.raw`C:\Program Files\PowerShell\7\pwsh.exe`;
const TOKEN_CHECK = [
  "$ErrorActionPreference='Stop'",
  "$identity=[Security.Principal.WindowsIdentity]::GetCurrent()",
  "$principal=[Security.Principal.WindowsPrincipal]::new($identity)",
  "if([string]$identity.User.Value -eq 'S-1-5-18'){[Console]::Out.Write('RC_SYSTEM_TOKEN')}elseif($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){[Console]::Out.Write('RC_ELEVATED_ADMIN_TOKEN')}else{[Console]::Out.Write('RC_NON_ELEVATED_USER_TOKEN')}"
].join(';');

/** A read-only check of the CURRENT worker process's own Windows token.
 * A SYSTEM service or named pipe existing elsewhere is not evidence that
 * this worker can actually execute elevated commands.
 */
export async function probeWindowsAdministrator({
  platform = process.platform, execute = execFile, timeoutMs = 3000
} = {}) {
  if (platform !== 'win32') return { ok:false, code:'WINDOWS_TOKEN_NOT_APPLICABLE' };
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 5000) {
    return { ok:false, code:'WINDOWS_TOKEN_TIMEOUT_INVALID' };
  }
  return new Promise(resolve => {
    try {
      execute(MACHINE_PWSH, [
        '-NoLogo','-NoProfile','-NonInteractive','-Command',TOKEN_CHECK
      ], { timeout:timeoutMs, windowsHide:true, maxBuffer:1024 },
      (error,stdout,stderr) => {
        if (error || typeof stderr!=='string' || stderr.trim()) {
          resolve({ok:false,code:'WINDOWS_TOKEN_PROBE_FAILED'});return;
        }
        if (stdout==='RC_ELEVATED_ADMIN_TOKEN') {
          resolve({ok:true,isAdmin:true,isSystem:false,elevation:'high',source:'local-process-token'});
        } else if (stdout==='RC_SYSTEM_TOKEN') {
          resolve({ok:true,isAdmin:true,isSystem:true,elevation:'system',source:'local-process-token'});
        } else if (stdout==='RC_NON_ELEVATED_USER_TOKEN') {
          resolve({ok:true,isAdmin:false,isSystem:false,elevation:'standard',source:'local-process-token'});
        } else {
          resolve({ok:false,code:'WINDOWS_TOKEN_PROBE_INVALID'});
        }
      });
    } catch {
      resolve({ok:false,code:'WINDOWS_TOKEN_PROBE_UNAVAILABLE'});
    }
  });
}
