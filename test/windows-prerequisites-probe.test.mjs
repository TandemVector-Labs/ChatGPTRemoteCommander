import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const root=path.resolve(import.meta.dirname,'..');
const installer=fs.readFileSync(path.join(root,'installer','RemoteCommander.iss'),'utf8');
const server=fs.readFileSync(path.join(root,'server-install-windows.ps1'),'utf8');

test('Inno checks the owner-local prerequisites without UAC before any privileged bootstrap',()=>{
  const section=installer.slice(installer.indexOf('function PrepareToInstall'),
    installer.indexOf('procedure CurStepChanged'));
  const probe=section.indexOf(' -PrerequisitesProbe');
  const uac=section.indexOf("ShellExec('runas'");
  assert.ok(probe>=0 && uac>probe);
  assert.match(section,/if ResultCode = 42 then/);
  assert.match(section,/else if ResultCode <> 0 then/);
  assert.match(section,/ -PrerequisitesOnly/);
  assert.match(section,/if not ExistingCore then Params := Params \+ ' -StandardMode'/);
  assert.ok(!section.includes('runas\x27, PwshPath, Params') || uac>probe);
});

test('read-only probe is before Administrator and ProgramData mutation guards',()=>{
  const probe=server.indexOf('if ($PrerequisitesProbe) {');
  const admin=server.indexOf("if (-not (Test-Administrator))");
  const downloads=server.indexOf('New-Item -ItemType Directory -Force -Path $Downloads');
  assert.ok(probe>=0 && probe<admin && probe<downloads);
  assert.match(server,/PREREQUISITES_PROBE_EXCLUSIVE_MODE_REQUIRED/);
  assert.match(server,/SERVER_PREREQUISITES_LOCAL_PROBE_PASS/);
  assert.match(server,/SERVER_PREREQUISITES_LOCAL_PROBE_MISSING/);
  assert.match(server,/\$receipt\.Attributes -band \[IO\.FileAttributes\]::ReparsePoint/);
  assert.match(server,/\$prior\.antivirusExclusionsAdded -ne \$false/);
  assert.match(server,/exit 42/);
});

function withProgramData(value) {
  // Windows env variables are case-insensitive. Avoid duplicate PROGRAMDATA /
  // ProgramData keys because the child process may retain the original.
  const env={...process.env};
  for(const k of Object.keys(env)) if(k.toLowerCase()==='programdata') delete env[k];
  env.PROGRAMDATA=value;
  return env;
}

const winOnly=process.platform==='win32'?test:test.skip;
winOnly('native read-only probe rejects missing machine receipt without creating files',()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'rc-v012-prereq-missing-'));
  try{
    const p=spawnSync('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive',
      '-File',path.join(root,'server-install-windows.ps1'),'-PrerequisitesProbe'],{
      encoding:'utf8',timeout:15000,env:withProgramData(tmp)
    });
    assert.equal(p.status,42,p.stderr);
    assert.match(p.stdout,/SERVER_PREREQUISITES_LOCAL_PROBE_MISSING/);
    // Windows/PowerShell may materialize its own Microsoft runtime directory.
    // Only Commander-owned state, service or receipt mutation is in scope.
    assert.ok(!fs.existsSync(path.join(tmp,'ChatGPTRemoteCommander')));
  }finally{fs.rmSync(tmp,{recursive:true,force:true})}
});

winOnly('invalid prior machine receipt fails closed instead of skipping UAC',()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'rc-v012-prereq-untrusted-'));
  try {
    const sub=path.join(tmp,'ChatGPTRemoteCommander');
    fs.mkdirSync(sub);
    const file=path.join(sub,'server-install-allowlist.json');
    const invalid=JSON.stringify({
      schema:1,resolvedCommit:'PREREQUISITES_ONLY',
      antivirusExclusionsAdded:true,server:{installationType:'Client'}
    });
    fs.writeFileSync(file,invalid);
    const p=spawnSync('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive',
      '-File',path.join(root,'server-install-windows.ps1'),'-PrerequisitesProbe'],{
      encoding:'utf8',timeout:15000,env:withProgramData(tmp)
    });
    assert.equal(p.status,42,p.stderr);
    assert.match(p.stdout,/SERVER_PREREQUISITES_LOCAL_PROBE_MISSING/);
    assert.equal(fs.readFileSync(file,'utf8'),invalid);
  }finally{fs.rmSync(tmp,{recursive:true,force:true})}
});

winOnly('native existing-prerequisites path accepts a preexisting bounded machine receipt without UAC',()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'rc-v012-prereq-present-'));
  try{
    const sub=path.join(tmp,'ChatGPTRemoteCommander');
    fs.mkdirSync(sub);
    const file=path.join(sub,'server-install-allowlist.json');
    const data=JSON.stringify({
      schema:1,resolvedCommit:'PREREQUISITES_ONLY',
      sourceRef:'test-v0.12',antivirusExclusionsAdded:false,
      server:{installationType:'Client'},artifacts:[]
    });
    fs.writeFileSync(file,data);
    const p=spawnSync('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive',
      '-File',path.join(root,'server-install-windows.ps1'),'-PrerequisitesProbe'],{
      encoding:'utf8',timeout:15000,env:withProgramData(tmp)
    });
    assert.equal(p.status,0,p.stderr+'\n'+p.stdout);
    assert.match(p.stdout,/SERVER_PREREQUISITES_LOCAL_PROBE_PASS/);
    assert.equal(fs.readFileSync(file,'utf8'),data);
    assert.deepEqual(fs.readdirSync(sub),['server-install-allowlist.json']);
  }finally{fs.rmSync(tmp,{recursive:true,force:true})}
});
