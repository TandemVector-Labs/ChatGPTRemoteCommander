import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=fs.readFileSync(path.join(root,'auto-update-windows.ps1'),'utf8');

test('Windows 0.12 protected NoPromote QA is separate from promotion and real authenticated Doctor',()=>{
  const before=source.indexOf('  function Test-ProtectedNoPromoteCandidate(');
  const after=source.indexOf('  $device=if($currentStatus)',before);
  assert.ok(before>=0&&after>before);
  const fn=source.slice(before,after);
  assert.match(fn,/\$NoPromote/);
  assert.match(fn,/0\\\.12\\\.0/);
  assert.match(fn,/qa-v012-no-promote-ingress\.mjs/);
  assert.match(fn,/G1_J01_POSITIVE_UNPROVED/);
  const diagnostic=source.indexOf('$protectedCandidate=Test-ProtectedNoPromoteCandidate $stage.Version $expected',after);
  const final=source.indexOf('if($protectedCandidate){',source.indexOf('FINAL_CANDIDATE_DOCTOR_FAIL',diagnostic)-300);
  assert.ok(diagnostic>=0);
  assert.ok(source.indexOf('Assert-ProtectedNoPromoteNegativeOnly $stage.Dir $port $t.Profile',diagnostic)>=0);
  assert.ok(final>=0);
  for(const required of [
    'CANDIDATE_DOCTOR_FAIL','FINAL_CANDIDATE_DOCTOR_FAIL',
    'FULL_POWER_SHELL_E2E_FAIL','SCHEMA_CONTINUITY_GATE_FAIL'
  ])assert.ok(source.includes(required),'positive or rollback gate must remain '+required);
  assert.match(source,/NEGATIVE_ONLY_G1_J01_UNPROVED/);
  assert.match(source,/if\(\$NoPromote\)\{\s*foreach\(\$c in \$candidates\)/);
});

test('native Windows QA branch selection is only NoPromote + protected v0.12 dev/rc',()=>{
  if(process.platform!=='win32')return;
  const start=source.indexOf('  function Test-ProtectedNoPromoteCandidate(');
  const end=source.indexOf('  function Assert-ProtectedNoPromoteNegativeOnly(',start);
  assert.ok(start>=0&&end>start);
  const fn=source.slice(start,end);
  const script=[
    "$ErrorActionPreference='Stop'",
    fn,
    "$Config=[pscustomobject]@{capabilityProfile=[pscustomobject]@{tier='FULL_POWER'};powerMode=[pscustomobject]@{enabled=$true};requireTrustedIngress=$true}",
    "$NoPromote=$true",
    "if(-not(Test-ProtectedNoPromoteCandidate '0.12.0-dev.1' $Config)){throw 'EXPECTED_PROTECTED_QA'}",
    "$NoPromote=$false",
    "if(Test-ProtectedNoPromoteCandidate '0.12.0-dev.1' $Config){throw 'PROMOTE_MUST_USE_POSITIVE_DOCTOR'}",
    "$NoPromote=$true",
    "if(Test-ProtectedNoPromoteCandidate '0.12.0' $Config){throw 'STABLE_MUST_USE_POSITIVE_DOCTOR'}",
    "if(Test-ProtectedNoPromoteCandidate '0.11.0-dev.23' $Config){throw 'LEGACY_MUST_USE_POSITIVE_DOCTOR'}",
    "$Config=[pscustomobject]@{capabilityProfile=[pscustomobject]@{tier='STANDARD'};powerMode=[pscustomobject]@{enabled=$false};requireTrustedIngress=$false}",
    "if(Test-ProtectedNoPromoteCandidate '0.12.0-dev.1' $Config){throw 'STANDARD_MUST_USE_POSITIVE_DOCTOR'}",
    "Write-Output 'WIN_QA_NEGATIVE_SCOPE_PASS'"
  ].join('\n');
  const run=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',timeout:12000});
  assert.equal(run.status,0,run.stderr||run.stdout);
  assert.match(run.stdout,/WIN_QA_NEGATIVE_SCOPE_PASS/);
});
