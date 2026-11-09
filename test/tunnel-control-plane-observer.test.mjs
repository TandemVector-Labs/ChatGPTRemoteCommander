import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=fs.readFileSync(path.join(root,'autostart-windows.ps1'),'utf8');
const begin=source.indexOf('$script:TunnelControlPlaneNextCheck = @{}');
const end=source.indexOf('function Get-TunnelProcess',begin);

test('Windows tunnel supervision observes control plane without restarting or exposing credentials',()=>{
  assert.ok(begin>=0&&end>begin,'standalone supervisor observation function required');
  const observer=source.slice(begin,end);
  for(const marker of [
    'Observe-TunnelControlPlane','/health/control-plane','AddSeconds(30)',
    'TUNNEL_CONTROL_PLANE_DEGRADED','TUNNEL_CONTROL_PLANE_RECOVERED',
    'category=$category','http=$http','Write-SupervisorLog'
  ]) assert.ok(observer.includes(marker),'missing '+marker);
  assert.match(source,/Observe-TunnelControlPlane \$item\.Profile \$item\.HealthPort/u);
  // The cross-session healthy-tunnel guard skips competitor launches. Observe
  // before that guard so a SYSTEM-owned healthy tunnel still reports degradation.
  assert.match(source,/\$ready = Test-TunnelReady \$item\.HealthPort\s+Observe-TunnelControlPlane \$item\.Profile \$item\.HealthPort\s+if \(-not \$process -and \$ready\)/u);
  assert.match(source,/if \(-not \$process -or -not \$ready\) \{ Start-TunnelProfile \$item \}/u);
  assert.match(source,/TUNNEL_OWNER_UNVERIFIED/u);
  assert.doesNotMatch(observer,/Stop-Process|Start-Process|Restart-Service|Read-RcCredential|CONTROL_PLANE_API_KEY/u);
});

test('Windows mock 403 stays degraded until polling recovers and never enters a restart loop',
  {skip:process.platform!=='win32'},()=>{
    const result=spawnSync('pwsh.exe',[
      '-NoLogo','-NoProfile','-NonInteractive',
      '-File',path.join(root,'test','tunnel-control-plane-observer-windows.ps1')
    ],{cwd:root,encoding:'utf8',timeout:15000,windowsHide:true});
    assert.equal(result.status,0,result.stderr||result.stdout);
    assert.match(result.stdout,/TUNNEL_POLL_OBSERVER_PASS/u);
});
