import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('versioned ZIP wizards use exact source tag+commit rather than stale default', {
  skip: process.platform !== 'linux' ? 'Linux release packaging requires Bash/Python' : false,
  timeout: 30000
}, t => {
  const temp = mkdtempSync(join(tmpdir(), 'rc-release-pin-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const version = JSON.parse(readFileSync('package.json','utf8')).version;
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const out = join(temp, 'release');
  const built = spawnSync('bash',['tools/build-release-assets.sh',out],{
    encoding: 'utf8', timeout: 25000, maxBuffer: 4*1024*1024
  });
  assert.equal(built.status,0,(built.stderr || '') + (built.stdout || ''));
  const read = (name,path) => {
    const script = 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]);sys.stdout.write(z.read(sys.argv[2]).decode())';
    const p = spawnSync('python3',['-c',script,join(out,name),path],{encoding:'utf8'});
    assert.equal(p.status,0,p.stderr);
    return p.stdout;
  };
  const universal = 'ChatGPT-Remote-Commander-v'+version+'-Installer.zip';
  const windows = 'ChatGPT-Remote-Commander-Windows-Setup-v'+version+'.zip';
  const linux = 'ChatGPT-Remote-Commander-Linux-Setup-v'+version+'.zip';
  const psPin = "'-SourceRef','v"+version+"','-ExpectedCommit','"+commit+"'";
  const shellRef = "export REMOTE_COMMANDER_SOURCE_REF='v"+version+"'";
  const shellCommit = "export REMOTE_COMMANDER_EXPECTED_COMMIT='"+commit+"'";
  for(const name of [universal,windows]) assert.ok(read(name,'setup-wizard.ps1').includes(psPin),name);
  for(const name of [universal,linux]){
    const script = read(name,'setup-wizard.sh');
    assert.ok(script.includes(shellRef),name);
    assert.ok(script.includes(shellCommit),name);
    assert.ok(script.includes('bash "$INSTALLER" "$' + '{args[@]}"'),name);

  }
});
