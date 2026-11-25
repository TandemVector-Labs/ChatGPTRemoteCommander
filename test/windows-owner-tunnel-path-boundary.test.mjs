import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readWindowsOwnerTunnelBinding} from '../packaging/unified/migration-preflight.mjs';

test('Windows owner tunnel preflight denies linked parent directories and multi-link profiles',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rc-windows-tunnel-directory-'));
  const appData=path.join(root,'app');
  const elsewhere=path.join(root,'untrusted');
  const directory=path.join(appData,'tunnel-client');
  const profile='owner-exact';
  const elsewhereYaml=path.join(elsewhere,profile+'.yaml');
  let linked=false,hardlinked=false;
  try {
    fs.mkdirSync(appData);
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(elsewhereYaml,[
      'mcp:',
      '  server_urls:',
      '    - channel: main',
      '      url: "http://127.0.0.1:48833/mcp"'
    ].join('\n'),{mode:0o600});
    try{
      fs.symlinkSync(elsewhere,directory,process.platform==='win32'?'junction':'dir');
      linked=true;
      assert.deepEqual(readWindowsOwnerTunnelBinding({appData,profileName:profile}),
        {profilePresent:true,valid:false},'linked tunnel-client directory was trusted');
    } catch(error){
      if(!linked&&['EPERM','EACCES','ENOTSUP','EOPNOTSUPP'].includes(error?.code))
        t.diagnostic('Platform denied disposable directory-link fixture: '+error.code);
      else throw error;
    }
    if(linked){fs.unlinkSync(directory);linked=false;}
    fs.mkdirSync(directory,{mode:0o700});
    try{
      fs.linkSync(elsewhereYaml,path.join(directory,profile+'.yaml'));
      hardlinked=true;
      assert.deepEqual(readWindowsOwnerTunnelBinding({appData,profileName:profile}),
        {profilePresent:true,valid:false},'multiply linked YAML accepted as owner-local');
    }catch(error){
      if(!hardlinked&&['EPERM','EACCES','ENOTSUP','EOPNOTSUPP'].includes(error?.code))
        t.diagnostic('Platform denied disposable file-link fixture: '+error.code);
      else throw error;
    }
    if(hardlinked)fs.unlinkSync(path.join(directory,profile+'.yaml'));
    if(!linked&&!hardlinked&&process.platform==='win32')
      t.diagnostic('Both link kinds blocked by host; regular-file positive contract still checked');
    fs.copyFileSync(elsewhereYaml,path.join(directory,profile+'.yaml'));
    assert.deepEqual(readWindowsOwnerTunnelBinding({appData,profileName:profile}),
      {profilePresent:true,valid:true,port:48833,tls:false},
      'a regular owner-local YAML must remain a valid observable binding');
  }finally{
    if(linked)try{fs.unlinkSync(directory);}catch{}
    fs.rmSync(root,{recursive:true,force:true});
  }
});
