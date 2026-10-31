import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guard = path.join(root, 'tools/runner-policy-continuity.mjs');
const runner = {enabled: true, autoTick: false, provider:{kind:'command', executable:'/tmp/owner-only-provider'},
  maxActions:2,worker:{enabled:false}};
const clone = obj => JSON.parse(JSON.stringify(obj));
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rc-runner-continuity-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const current=path.join(dir,'current.json'),candidate=path.join(dir,'candidate.json');
  const write=(file, policy)=>fs.writeFileSync(file,JSON.stringify({durableWorkflows:{runner:policy}}));
  return {current,candidate,write,run:()=>spawnSync(process.execPath,[guard,current,candidate],
    {encoding:'utf8',timeout:3000})};
}
test('owner runner survives unchanged while the guard never prints its provider executable',t=>{
  const f=fixture(t);f.write(f.current,runner);f.write(f.candidate,clone(runner));
  const outcome=f.run();assert.equal(outcome.status,0,outcome.stderr);
  assert.match(outcome.stdout,/RUNNER_CONTINUITY_PASS/);
  assert.ok(!outcome.stdout.includes('owner-only-provider'));
});
test('existing owner single-planner cannot silently gain a team',t=>{
  const f=fixture(t);f.write(f.current,runner);
  f.write(f.candidate,{...runner,team:{workers:[{id:'builder',role:'Build'}],maxParallel:1}});
  assert.equal(f.run().status,3);
});
test('runner deactivation and provider changes fail closed',t=>{
  const f=fixture(t);f.write(f.current,runner);
  for(const altered of [{...runner,enabled:false},{...runner,provider:{kind:'disabled'}},
    {...runner,worker:{enabled:true}}]){
    f.write(f.candidate,altered);assert.equal(f.run().status,3);
  }
});
test('unconfigured runner cannot become active without existing owner authorization',t=>{
  const f=fixture(t);f.write(f.current,{enabled:false});f.write(f.candidate,runner);
  assert.equal(f.run().status,3);
  f.write(f.candidate,{enabled:false});assert.equal(f.run().status,0);
});
test('invalid, unreadable and symlinked config files fail closed',t=>{
  const f=fixture(t);f.write(f.current,runner);
  fs.writeFileSync(f.candidate,'{not valid');assert.equal(f.run().status,3);
  fs.rmSync(f.candidate);assert.equal(f.run().status,3);
  try {fs.symlinkSync(f.current,f.candidate);assert.equal(f.run().status,3);}
  catch(error){if(!['EPERM','EACCES','ENOTSUP'].includes(error.code))throw error;}
});
test('both Linux updater phases enforce runner continuity before candidate launch',()=>{
  const code=fs.readFileSync(path.join(root,'auto-update-linux.sh'),'utf8');
  const diag=code.indexOf('RUNNER_POLICY_GUARD="$INSTALL_DIR/tools/runner-policy-continuity.mjs"');
  const first=code.indexOf('node "$RUNNER_POLICY_GUARD" "$ACTIVE_CFG" "$DIAG_CFG"');
  const diagStart=code.indexOf('CANDIDATE_PID="$(start_backend',first);
  const final=code.indexOf('node "$RUNNER_POLICY_GUARD" "$ACTIVE_CFG" "$FINAL_CFG"');
  const finalStart=code.indexOf('CANDIDATE_PID="$(start_backend',final);
  assert.ok(diag>=0&&first>diag&&diagStart>first&&final>diagStart&&finalStart>final);
});


test('hardlinked candidate config is rejected even when the runner is unchanged',t=>{
  const f=fixture(t);f.write(f.current,runner);
  // The candidate cannot be an alias of another file at approval time.
  try { fs.linkSync(f.current,f.candidate); }
  catch (error) {
    if (['EPERM','EACCES','ENOTSUP','ENOSYS','EXDEV'].includes(error.code)) return t.skip('Hardlinks unavailable on this host');
    throw error;
  }
  const outcome=f.run();
  assert.equal(outcome.status,3);
  assert.match(outcome.stderr,/RUNNER_CONTINUITY_BLOCK INVALID_FILE/);
});

test('team-budget increase cannot bypass the unchanged runner contract',t=>{
  const f=fixture(t);
  const active={...runner,maxPlannerCalls:2,team:{workers:[
    {id:'builder',role:'Build'},{id:'reviewer',role:'Review'}],maxParallel:2}};
  f.write(f.current,active);
  f.write(f.candidate,{...active,maxPlannerCalls:3});
  let outcome=f.run();
  assert.equal(outcome.status,3);
  assert.match(outcome.stderr,/RUNNER_POLICY_CHANGED/);
  // Combining a model adapter change with a budget change must not evade the guard.
  f.write(f.candidate,{...active,maxPlannerCalls:3,
    provider:{...active.provider,executable:'/tmp/second-owner-provider'}});
  outcome=f.run();
  assert.equal(outcome.status,3);
  assert.match(outcome.stderr,/RUNNER_POLICY_CHANGED/);
  assert.ok(!outcome.stderr.includes('/tmp/second-owner-provider'));
});

test('an unrecognized owner-approval argument cannot disable the continuity guard',t=>{
  const f=fixture(t);
  f.write(f.current,{...runner,maxPlannerCalls:2});
  f.write(f.candidate,{...runner,maxPlannerCalls:3});
  const outcome=spawnSync(process.execPath,[guard,f.current,f.candidate,
    '--owner-approval','/tmp/not-issued-owner-approval.json'],
    {encoding:'utf8',timeout:3000});
  assert.equal(outcome.status,3);
  assert.match(outcome.stderr,/INVALID_ARGS/);
});
