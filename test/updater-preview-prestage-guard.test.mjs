import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const source=readFileSync(resolve('auto-update-windows.ps1'),'utf8');
const start=source.indexOf('  $ref=Get-LatestTag');
const end=source.indexOf('  $stage=Stage-Release $ref',start);
assert.ok(start>=0 && end>start,'prestage tag authority gate missing');
const body=source.slice(start,end).replace('  $ref=Get-LatestTag','$ref=$env:RC_TARGET_REF');
assert.ok(body.includes('AUTO_UPDATE_NEWER_PERSISTED_ROUTE_PRESTAGE'));
assert.ok(body.includes("if(-not $Force"));

const cases=[
 {name:'newer-preview-skips-old-stable-before-staging',version:'0.10.26',force:false,ref:'v0.10.20',expected:'NEWER_CURRENT'},
 {name:'equal-version-can-stage',version:'0.10.20',force:false,ref:'v0.10.20',expected:'CONTINUED'},
 {name:'malformed-route-fails-closed',version:'0.10.26',force:false,ref:'v0.10.20',invalid:true,expected:'FAILED'},
 {name:'explicit-force-preserves-rollback',version:'0.10.26',force:true,ref:'v0.10.20',expected:'CONTINUED'},
 {name:'sha-ref-preserves-normal-qualification',version:'0.10.26',force:false,ref:'a9ff80f65a7fdd09fb4bcbb4a24893bb81674ba2',expected:'CONTINUED'}
];
for(const c of cases){
  test('updater prestage: '+c.name,{skip:process.platform!=='win32'},()=>{
    const dir=mkdtempSync(join(tmpdir(),'rc-prestage-preview-'));
    try{
      const script=join(dir,'probe.ps1'),route=join(dir,'default.json'),result=join(dir,'result.json');
      writeFileSync(route,JSON.stringify({schema:1,profile:'default',active:{version:c.version,commit:c.invalid?'bogus':'a9ff80f65a7fdd09fb4bcbb4a24893bb81674ba2'}}));
      const prelude=[
        "$ErrorActionPreference='Stop'",
        '$Force=($env:RC_FORCE -eq "true")',
        '$report=[ordered]@{status="RUNNING"}',
        '$ResultFile=$env:RC_RESULT',
        "function Get-LatestTag { return $env:RC_TARGET_REF }",
        "function Get-RoutePath([string]$profile){return $env:RC_ROUTE}",
        "function Read-Json([string]$path){return Get-Content -LiteralPath $path -Raw|ConvertFrom-Json}",
        'function Test-VersionGreater([string]$a,[string]$b){return ([version]$a -gt [version]$b)}',
        'function Atomic-Json([string]$path,[object]$obj){$obj|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $path}',
        'function Log([string]$msg){Write-Output $msg}'
      ].join('\n');
      writeFileSync(script,prelude+'\n'+body+'\nWrite-Output "CONTINUED_TO_STAGE"\n','utf8');
      const run=spawnSync('pwsh',['-NoLogo','-NoProfile','-NonInteractive','-File',script],{
        encoding:'utf8',timeout:10000,env:{...process.env,RC_ROUTE:route,RC_RESULT:result,RC_FORCE:String(c.force),RC_TARGET_REF:c.ref}
      });
      assert.equal(run.error,undefined,String(run.error));
      if(c.expected==='FAILED'){
        assert.notEqual(run.status,0,'unverified route may not stage');
        assert.ok(!(run.stdout||'').includes('CONTINUED_TO_STAGE'));
      }else if(c.expected==='NEWER_CURRENT'){
        assert.equal(run.status,0,run.stderr);
        assert.equal(JSON.parse(readFileSync(result,'utf8')).status,'NEWER_CURRENT');
        assert.equal(JSON.parse(readFileSync(result,'utf8')).authoritySource,'PERSISTED_ROUTE_PRESTAGE');
        assert.ok(!run.stdout.includes('CONTINUED_TO_STAGE'));
      }else{
        assert.equal(run.status,0,run.stderr);
        assert.ok(run.stdout.includes('CONTINUED_TO_STAGE'));
        assert.equal(existsSync(result),false);
      }
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
}