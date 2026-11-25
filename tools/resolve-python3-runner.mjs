// Bounded host-Python discovery for the exact release-train fixture validator.
// Windows images may have Python 3 without the optional "py" launcher.
// Invalid or Store-alias-only interpreters never satisfy this dependency.
import {spawnSync} from 'node:child_process';

export function resolvePython3Runner({
  platform=process.platform,run=spawnSync
}={}){
  if(!['win32','linux'].includes(platform)||typeof run!=='function')
    throw new TypeError('RELEASE_TRAIN_PYTHON_PLATFORM_INVALID');
  const choices=platform==='win32'
    ? [['py',['-3']],['python3',[]],['python',[]]]
    : [['python3',[]]];
  for(const [command,prefixArgs] of choices){
    let probe;
    try{
      probe=run(command,[...prefixArgs,'-c',
        'import sys;raise SystemExit(0 if sys.version_info.major==3 else 1)'],
      {windowsHide:true,encoding:'utf8',timeout:5000,maxBuffer:4096});
    }catch{continue;}
    if(probe&&probe.status===0&&!probe.error&&!probe.signal){
      return Object.freeze({command,prefixArgs:Object.freeze([...prefixArgs])});
    }
  }
  throw new Error('RELEASE_TRAIN_PYTHON3_REQUIRED');
}
