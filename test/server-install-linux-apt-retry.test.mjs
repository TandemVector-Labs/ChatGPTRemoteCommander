import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const source=readFileSync('server-install-linux.sh','utf8').replace(/\r\n?/g,'\n');
const userSource=readFileSync('install.sh','utf8').replace(/\r\n?/g,'\n');
const functionBody=source.match(/^install_bootstrap_packages\(\) \{[\s\S]*?^\}/m)?.[0];
const userFunctionBody=userSource.match(/^install_os_packages\(\) \{[\s\S]*?^\}/m)?.[0];
const bash=process.platform==='win32'
  ? join('C:\\Program Files','Git','bin','bash.exe')
  : 'bash';
const bashAvailable=process.platform==='win32'?existsSync(bash):true;
test('Linux apt bootstrap refreshes package indexes and retries transient package mirror 404', {skip:!bashAvailable},()=>{
  assert.ok(functionBody,'bootstrap package function must be extractable');
  const harness=[
    'set -euo pipefail',
    'updates=0; installs=0',
    'need(){ [[ "$1" == apt-get ]]; }',
    'as_root(){ "$@"; }',
    'sleep(){ :; }',
    'apt-get(){',
    '  local last="${!#}"',
    '  if [[ "$last" == update ]]; then updates=$((updates+1)); return 0; fi',
    '  installs=$((installs+1))',
    '  [[ "$1" == -o && "$2" == Acquire::Retries=3 ]]',
    '  [[ "$installs" -gt 1 ]]',
    '}',
    functionBody,
    'install_bootstrap_packages',
    'test "$updates" -eq 2',
    'test "$installs" -eq 2',
    'echo APT_BOOTSTRAP_TRANSIENT_404_RETRY_PASS'
  ].join('\n');
  const result=spawnSync(bash,['-s'],{input:harness,encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr||result.stdout);
  assert.match(result.stdout,/APT_BOOTSTRAP_TRANSIENT_404_RETRY_PASS/);
});

test('Linux apt bootstrap fails closed after exactly three unavailable attempts', {skip:!bashAvailable},()=>{
  assert.ok(functionBody,'bootstrap package function must be extractable');
  const harness=[
    'set -euo pipefail',
    'updates=0; installs=0',
    'need(){ [[ "$1" == apt-get ]]; }',
    'as_root(){ "$@"; }',
    'sleep(){ :; }',
    'apt-get(){ local last="${!#}"; if [[ "$last" == update ]]; then updates=$((updates+1)); return 0; fi; installs=$((installs+1)); return 100; }',
    functionBody,
    'if install_bootstrap_packages; then echo UNEXPECTED_APT_SUCCESS; exit 91; fi',
    'test "$updates" -eq 3',
    'test "$installs" -eq 3',
    'echo APT_BOOTSTRAP_BOUNDED_FAILURE_PASS'
  ].join('\n');
  const result=spawnSync(bash,['-s'],{input:harness,encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr||result.stdout);
  assert.match(result.stderr,/APT_BOOTSTRAP_PREREQUISITES_FAILED_AFTER_3_ATTEMPTS/);
  assert.match(result.stdout,/APT_BOOTSTRAP_BOUNDED_FAILURE_PASS/);
});

test('Linux normal user install retries apt mirror 404 and succeeds after fresh index', {skip:!bashAvailable},()=>{
  assert.ok(userFunctionBody,'install.sh apt prerequisite function must be extractable');
  const harness=[
    'set -euo pipefail',
    'INSTALL_PREREQS=1; updates=0; installs=0',
    'need(){ [[ "$1" == apt-get ]]; }',
    'id(){ echo 0; }',
    'sleep(){ :; }',
    'apt-get(){ local last="${!#}"; if [[ "$last" == update ]]; then updates=$((updates+1)); return 0; fi; installs=$((installs+1)); [[ "$1" == -o && "$2" == Acquire::Retries=3 && "$installs" -gt 1 ]]; }',
    userFunctionBody,
    'install_os_packages',
    'test "$updates" -eq 2 && test "$installs" -eq 2',
    'echo USER_INSTALL_APT_RETRY_PASS'
  ].join('\n');
  const result=spawnSync(bash,['-s'],{input:harness,encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr||result.stdout);
  assert.match(result.stdout,/USER_INSTALL_APT_RETRY_PASS/);
});

test('Linux normal user install remains fail-closed after three apt failures', {skip:!bashAvailable},()=>{
  assert.ok(userFunctionBody,'install.sh apt prerequisite function must be extractable');
  const harness=[
    'set -euo pipefail',
    'INSTALL_PREREQS=1; updates=0; installs=0',
    'need(){ [[ "$1" == apt-get ]]; }',
    'id(){ echo 0; }',
    'sleep(){ :; }',
    'apt-get(){ local last="${!#}"; if [[ "$last" == update ]]; then updates=$((updates+1)); return 0; fi; installs=$((installs+1)); return 100; }',
    userFunctionBody,
    'if install_os_packages; then exit 91; fi',
    'test "$updates" -eq 3 && test "$installs" -eq 3',
    'echo USER_INSTALL_APT_BOUNDED_FAILURE_PASS'
  ].join('\n');
  const result=spawnSync(bash,['-s'],{input:harness,encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr||result.stdout);
  assert.match(result.stderr,/APT_BOOTSTRAP_PREREQUISITES_FAILED_AFTER_3_ATTEMPTS/);
  assert.match(result.stdout,/USER_INSTALL_APT_BOUNDED_FAILURE_PASS/);
});
