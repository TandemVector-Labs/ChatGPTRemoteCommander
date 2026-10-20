// Fail closed on untrusted PATH entries and untrusted geckodriver installations.
import fs from 'node:fs';
import path from 'node:path';

export const SYSTEM_GECKODRIVERS=Object.freeze([
  '/usr/bin/geckodriver','/usr/local/bin/geckodriver','/snap/bin/geckodriver'
]);
export const WINDOWS_SYSTEM_GECKODRIVERS=Object.freeze([
  'C:\\Program Files\\GeckoDriver\\geckodriver.exe',
  'C:\\Program Files (x86)\\GeckoDriver\\geckodriver.exe'
]);

const safeFile=st=>st?.isFile?.()===true&&st.uid===0&&
  (st.mode&0o022)===0&&(st.mode&0o111)!==0;
const safeDirectory=st=>st?.isDirectory?.()===true&&st.uid===0&&(st.mode&0o022)===0;

/**
 * Select only system-managed install locations; never trust an executable
 * discovered from process.env.PATH or supplied by an untrusted request.
 *
 * On POSIX require a root-owned, non-group/world-writable real executable
 * and parents for both the visible and resolved paths. Windows permits only
 * static Program Files candidates, with no redirection via a symlink; ACL
 * ownership is enforced by Windows' protected Program Files installation.
 */
export function selectSystemGeckoDriver({
  platform=process.platform,
  candidates=platform==='win32'?WINDOWS_SYSTEM_GECKODRIVERS:SYSTEM_GECKODRIVERS,
  realpath=fs.realpathSync.native,
  stat=fs.statSync,
  lstat=fs.lstatSync
}={}){
  const windows=platform==='win32';
  const paths=windows?path.win32:path.posix;
  const allow=windows?WINDOWS_SYSTEM_GECKODRIVERS:SYSTEM_GECKODRIVERS;
  for(const original of candidates){
    if(!allow.includes(original))continue;
    try{
      const resolved=realpath(original);
      if(typeof resolved!=='string'||!paths.isAbsolute(resolved))continue;
      if(windows){
        if(resolved.toLowerCase()!==original.toLowerCase())continue;
        if(lstat(original).isSymbolicLink())continue;
        if(!stat(original).isFile())continue;
      }else{
        if(!safeFile(stat(resolved)))continue;
        if(lstat(original).uid!==0||(lstat(original).mode&0o022)!==0)continue;
        const dirs=new Set();
        for(const file of [original,resolved]){
          let dir=paths.dirname(file);
          for(;;){
            dirs.add(dir);
            const parent=paths.dirname(dir);
            if(parent===dir)break;
            dir=parent;
          }
        }
        if([...dirs].some(dir=>!safeDirectory(stat(dir))))continue;
      }
      return original;
    }catch{}
  }
  return null;
}
