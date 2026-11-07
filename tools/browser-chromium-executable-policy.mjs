// Refuse to run arbitrary requested executables or browsers sourced from PATH.
import fs from 'node:fs';
import path from 'node:path';

export const POSIX_CHROMIUM_BINARIES=Object.freeze([
  '/usr/bin/google-chrome','/usr/bin/google-chrome-stable',
  '/usr/bin/chromium','/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge','/usr/bin/msedge',
  '/snap/bin/chromium','/opt/google/chrome/chrome','/opt/microsoft/msedge/msedge'
]);
export const WINDOWS_CHROMIUM_BINARIES=Object.freeze([
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
]);

const safeFile=st=>st?.isFile?.()===true&&st.uid===0&&
  (st.mode&0o022)===0&&(st.mode&0o111)!==0;
const safeDir=st=>st?.isDirectory?.()===true&&st.uid===0&&(st.mode&0o022)===0;

/**
 * Launch only known operating-system managed Chromium installations.
 * Explicit caller paths are permitted only if identical to an approved path.
 * Real POSIX file and all visible/target ancestors must be root-owned and
 * non-group/world-writable. Windows allows non-redirected Program Files only.
 */
export function selectTrustedChromium(explicit, {
  platform=process.platform,
  realpath=fs.realpathSync.native,
  stat=fs.statSync,
  lstat=fs.lstatSync
}={}){
  const windows=platform==='win32';
  const pathApi=windows?path.win32:path.posix;
  const allow=windows?WINDOWS_CHROMIUM_BINARIES:POSIX_CHROMIUM_BINARIES;
  const choices=explicit===undefined||explicit===null||explicit===''?allow:
    typeof explicit==='string'&&allow.includes(explicit)?[explicit]:[];
  for(const candidate of choices){
    try{
      const target=realpath(candidate);
      if(typeof target!=='string'||!pathApi.isAbsolute(target))continue;
      if(windows){
        if(target.toLowerCase()!==candidate.toLowerCase())continue;
        if(lstat(candidate).isSymbolicLink())continue;
        if(!stat(candidate).isFile())continue;
      }else{
        if(!safeFile(stat(target)))continue;
        if(lstat(candidate).uid!==0||(lstat(candidate).mode&0o022)!==0)continue;
        const dirs=new Set();
        for(const executable of [candidate,target]){
          let folder=pathApi.dirname(executable);
          for(;;){
            dirs.add(folder);
            const above=pathApi.dirname(folder);
            if(folder===above)break;
            folder=above;
          }
        }
        if([...dirs].some(folder=>!safeDir(stat(folder))))continue;
      }
      return candidate;
    }catch{}
  }
  return null;
}
