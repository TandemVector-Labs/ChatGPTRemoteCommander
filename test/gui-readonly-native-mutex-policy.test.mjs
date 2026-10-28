import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const source = readFileSync(new URL('../tools/gui-control.ps1', import.meta.url), 'utf8');
const line = source.split(/\r?\n/).find(value => value.trimStart().startsWith('$nativeWaitMs = if ('));
test('native lock waits briefly only for read-only observations; input never queues', () => {
  assert.ok(line, 'native lock policy must exist');
  assert.match(source, /\$owned = \$mutex\.WaitOne\(\$nativeWaitMs\)/);
  assert.match(source, /if \(-not \$owned\) \{ return @\{ok=\$false;error='GUI_NATIVE_BUSY';submission='NOT_SUBMITTED'\} \}/);
  const policy = line.trim();
  const cases = [
    ['status',1500], ['screenshot',1500], ['cursor',1500], ['listWindows',1500],
    ['click',0], ['focusWindow',0], ['drag',0], ['typeText',0],
    ['move',0], ['moveRelative',0], ['scroll',0], ['keyPress',0]
  ];
  if (process.platform !== 'win32') return;
  const statement = [
    ...cases.map(([action]) => "$req=@{action='"+action+"'}; "+policy+"; [Console]::WriteLine([string]$nativeWaitMs)")
  ].join('; ');
  const run = spawnSync('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',statement],{encoding:'utf8',timeout:10000});
  assert.equal(run.status,0,run.stderr);
  const actual = run.stdout.trim().split(/\r?\n/).map(Number);
  assert.deepEqual(actual,cases.map(([,expected])=>expected));
});

test('native Windows status smoke uses the candidate helper without desktop input', {skip: process.platform !== 'win32' || process.env.RC_GUI_NATIVE_SMOKE !== '1'}, () => {
  const helper = new URL('../tools/gui-control.ps1', import.meta.url);
  const run = spawnSync('pwsh.exe', ['-NoLogo','-NoProfile','-NonInteractive','-File',decodeURIComponent(helper.pathname).replace(/^\//,'')], {
    input: '{"action":"status"}',
    encoding: 'utf8',
    timeout: 15000
  });
  assert.equal(run.status,0,run.stderr);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.ok(typeof result.available === 'boolean');
  assert.ok(Number.isInteger(result.inputSize) && result.inputSize > 0);
});
