import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const source=readFileSync(resolve('auto-update-windows.ps1'),'utf8');
const start=source.indexOf('  $currentStatus=$null');
const end=source.indexOf('  if(-not $Force -and $currentStatus -and (Test-VersionGreater',start);
assert.ok(start>=0 && end>start,'updater version guard block missing');
const guard=source.slice(start,end);

test('version guard protects routed and direct runtimes',()=>{
  for(const key of [
    'AUTO_UPDATE_ACTIVE_ROUTE_UNVERIFIED',
    'AUTO_UPDATE_ACTIVE_MCP_STATUS_UNVERIFIED',
    'AUTO_UPDATE_ROUTE_MCP_VERSION_CONFLICT',
    'AUTO_UPDATE_DIRECT_MCP_STATUS_UNVERIFIED',
    'source=route'
  ])assert.ok(guard.includes(key),key);
});

const prelude=[
  "$ErrorActionPreference='Stop'",
  '$caseName=$env:RC_GUARD_TEST_CASE',
  '$root=$env:RC_GUARD_TEST_ROOT',
  "$stage=[pscustomobject]@{Version='0.10.20';Commit='362375c464948be3001b307650c13fc3353ed05b'}",
  "$report=[ordered]@{status='RUNNING'}",
  '$Force=$false',
  "$InstallDir=Join-Path $root 'installed-app'",
  "$ResultFile=Join-Path $root 'result.json'",
  "$routePath=Join-Path $root 'default.json'",
  "if($caseName -match '^direct-'){",
  '  New-Item -ItemType Directory -Path $InstallDir -Force|Out-Null',
  '  [IO.File]::WriteAllText((Join-Path $InstallDir \'package.json\'),\'{"version":"0.10.24"}\')',
  '}else{',
  "  $version=if($caseName -eq 'routed-newer'){'0.10.24'}else{'0.10.20'}",
  "  $route=[ordered]@{schema=1;profile='default';active=@{version=$version;commit='362375c464948be3001b307650c13fc3353ed05b'}}",
  '  $route|ConvertTo-Json -Depth 5|Set-Content $routePath -Encoding utf8',
  '}',
  'function Get-RoutePath([string]$p){return $routePath}',
  'function Read-Json([string]$p){Get-Content -LiteralPath $p -Raw|ConvertFrom-Json}',
  'function Test-VersionGreater([string]$a,[string]$b){return ([version]$a -gt [version]$b)}',
  'function Invoke-Mcp([int]$p,[string]$n){',
  "  if($caseName -in @('routed-newer','routed-unverified','direct-active','direct-report','direct-fresh')){throw 'SIMULATED_STATUS_TIMEOUT'}",
  "  if($caseName -eq 'routed-mismatch'){return [pscustomobject]@{version='0.10.24'}}",
  "  return [pscustomobject]@{version='0.10.20'}",
  '}',
  "function Get-NetTCPConnection { if($caseName -eq 'direct-active'){return [pscustomobject]@{LocalPort=47831;State='Listen'}} }",
  "if($caseName -eq 'direct-report'){[IO.File]::WriteAllText($ResultFile,'{\"status\":\"PROMOTED\"}')} ",
  'function Atomic-Json([string]$p,[object]$v){}',
  "function Log([string]$s){Write-Output ('LOG='+$s)}"
].join('\n');

for(const c of [
  {name:'routed-newer',exit:0,marker:'NEWER_CURRENT'},
  {name:'routed-unverified',exit:1,marker:'AUTO_UPDATE_ACTIVE_MCP_STATUS_UNVERIFIED'},
  {name:'routed-mismatch',exit:1,marker:'AUTO_UPDATE_ROUTE_MCP_VERSION_CONFLICT'},
  {name:'routed-equal',exit:0,marker:'GUARD_CONTINUED'},
  {name:'direct-active',exit:1,marker:'AUTO_UPDATE_DIRECT_MCP_STATUS_UNVERIFIED'},
  {name:'direct-report',exit:1,marker:'AUTO_UPDATE_DIRECT_MCP_STATUS_UNVERIFIED'},
  {name:'direct-fresh',exit:0,marker:'GUARD_CONTINUED'}
]){
  test('Windows updater version guard: '+c.name,{skip:process.platform!=='win32'},()=>{
    const dir=mkdtempSync(join(tmpdir(),'rc-updater-version-guard-'));
    try{
      const script=join(dir,'case.ps1');
      writeFileSync(script,prelude+'\n'+guard+'\nWrite-Output "GUARD_CONTINUED"\n','utf8');
      const res=spawnSync('pwsh',['-NoProfile','-NonInteractive','-File',script],{
        encoding:'utf8',timeout:12000,env:{...process.env,RC_GUARD_TEST_CASE:c.name,RC_GUARD_TEST_ROOT:dir}
      });
      assert.equal(res.error,undefined,'process error: '+res.error);
      assert.equal(res.status,c.exit,'stdout='+res.stdout+' stderr='+res.stderr);
      assert.ok((res.stdout+res.stderr).includes(c.marker),'expected '+c.marker);
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
}
