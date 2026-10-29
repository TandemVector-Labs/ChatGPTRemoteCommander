import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundNodeTestConcurrency, parseQualificationArgs, prioritizeSensitiveQualificationCommands, isolateWindowsLeaseRegression, isolateWindowsTimingSensitiveRegressions, isolateWindowsProcessTreeRegression, isolateWindowsAgentHttpRegression, isolateWindowsTransferMeshHttpRegression, isolateWindowsWorkflowPlanRegression, isolateWindowsAsyncHttpRegression, isolateWindowsMcpConformanceRegression, isolateWindowsAutotickRegression, isolateWindowsStartupReadinessRegressions, prioritizeWindowsAdaptiveCold, markIsolatedQualificationPhases, splitWindowsQualificationCommands } from '../tools/run-bounded-test-script.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=rel=>fs.readFileSync(path.join(root,rel),'utf8');

test('qualification paths bound full test file concurrency',()=>{
  const pkg=JSON.parse(read('package.json'));
  const original=pkg.scripts.test;
  const result=boundNodeTestConcurrency(original,2);
  const checkOriginal=pkg.scripts.check;
  const checkResult=boundNodeTestConcurrency(checkOriginal,2);
  const originalCount=(original.match(/node --test /g)||[]).length;
  const boundedCount=(result.command.match(/node --test --test-concurrency=2 /g)||[]).length;
  assert.ok(originalCount>=1);
  assert.equal(result.replacements,originalCount);
  assert.equal(boundedCount,originalCount);
  assert.equal(result.command.includes('node --test test/'),false);
  const checkOriginalCount=(checkOriginal.match(/node --test /g)||[]).length;
  const checkBoundedCount=(checkResult.command.match(/node --test --test-concurrency=2 /g)||[]).length;
  assert.ok(checkOriginalCount>=1);
  assert.equal(checkResult.replacements,checkOriginalCount);
  assert.equal(checkBoundedCount,checkOriginalCount);
  assert.equal(checkResult.command.includes('node --test test/'),false);
  assert.equal(pkg.scripts['check:qualification'],'node tools/run-bounded-test-script.mjs --script check --concurrency 2');
  assert.equal(pkg.scripts['test:qualification'],'node tools/run-bounded-test-script.mjs --script test --concurrency 2');
  for (const sensitive of ['test/workflow-http.test.mjs','test/async-operations.test.mjs','test/tunnel-log-rotation.test.mjs','test/mcp-tasks-extension.test.mjs']) {
    for (const scriptName of ['check','test']) {
      const script = pkg.scripts[scriptName];
      assert.equal((script.match(new RegExp(sensitive.replaceAll('.', '[.]'), 'g')) || []).length, 1, `${scriptName} must reference ${sensitive} exactly once`);
      assert.ok(script.includes(`node --test ${sensitive}`), `${scriptName} must run ${sensitive} as an isolated test-file command`);
    }
  }
  const wrapper=read('tools/run-bounded-test-script.mjs');
  assert.ok(wrapper.includes("args.prioritizeSensitive||process.platform==='win32'"),'Windows updater qualification must prioritize isolated sensitive fixtures automatically');
  assert.ok(wrapper.includes("effectiveConcurrency=process.platform==='win32'?1:requestedConcurrency"),'Windows installer/updater qualification must use deterministic concurrency=1 under workstation load');
  const workflow=read('.github/workflows/ci.yml');
  assert.ok(workflow.includes("if: runner.os == 'Windows'"));
  assert.ok(workflow.includes('run: node tools/run-bounded-test-script.mjs --script check --concurrency 1 --prioritize-sensitive 1'));
  assert.equal(workflow.includes('run: npm run check:qualification'),false);
  assert.ok(workflow.includes('run: node tools/run-bounded-test-script.mjs --script test --concurrency 1 --prioritize-sensitive 1'));
  assert.equal(workflow.includes('run: npm run test:qualification'),false);
  assert.ok(workflow.includes("if: runner.os != 'Windows'"));
  assert.ok(workflow.includes('run: npm run check'));
  assert.ok(workflow.includes('run: npm test'));
  const installPs1=read('install.ps1');
  const installSh=read('install.sh');
  const updateLinux=read('auto-update-linux.sh');
  const updateWindows=read('auto-update-windows.ps1');
  assert.ok(installPs1.includes('& npm.cmd run check:qualification'));
  assert.ok(installPs1.includes('& npm.cmd run test:qualification'));
  assert.ok(installSh.includes('npm run check:qualification'));
  assert.ok(installSh.includes('npm run test:qualification'));
  assert.ok(updateLinux.includes('run_gate "$STAGE_DIR" check npm run check:qualification'));
  assert.ok(updateLinux.includes('run_gate "$STAGE_DIR" test npm run test:qualification'));
  assert.ok(updateWindows.includes("Run-Gate $stage.Dir 'check' @('run','check:qualification')"));
  assert.ok(updateWindows.includes("Run-Gate $stage.Dir 'test' @('run','test:qualification')"));
});

test('bounded test wrapper rejects unsafe configuration',()=>{
  assert.throws(()=>boundNodeTestConcurrency('node --test test/a.test.mjs',0),/CI_TEST_CONCURRENCY_INVALID/);
  assert.throws(()=>boundNodeTestConcurrency('node test/a.mjs',2),/CI_TEST_COMMAND_MISSING/);
  assert.deepEqual(parseQualificationArgs(['--script','test','--concurrency','2']),{script:'test',concurrency:'2',prioritizeSensitive:false});
  assert.deepEqual(parseQualificationArgs(['--script','check','--concurrency','2']),{script:'check',concurrency:'2',prioritizeSensitive:false});
  assert.deepEqual(parseQualificationArgs(['--script','test','--concurrency','1','--prioritize-sensitive','1']),{script:'test',concurrency:'1',prioritizeSensitive:true});
  assert.throws(()=>parseQualificationArgs(['--script','audit','--concurrency','2']),/CI_TEST_SCRIPT_NOT_ALLOWED/);
});


test('R157 schedules native autotick once outside the heavy Windows batch',()=>{
  const pkg=JSON.parse(read('package.json'));
  const original=prioritizeSensitiveQualificationCommands(
    boundNodeTestConcurrency(pkg.scripts.test,1).command);
  const file='test/project-autotick-noncodex.test.mjs';
  const isolated=isolateWindowsAutotickRegression(original);
  assert.equal(isolated.split(file).length-1,1,'exactly one original autotick test');
  assert.equal(isolated.split(' && ')[0],'node --test --test-concurrency=1 '+file);
  assert.equal(isolated.split(' && ').length,original.split(' && ').length+1);
  assert.ok(isolated.includes('test/project-engine-integration.test.mjs'));
  assert.equal(isolateWindowsAutotickRegression(isolated),isolated,'already isolated scheduling is idempotent');
  assert.throws(()=>isolateWindowsAutotickRegression(original.replace(' '+file,'')),/CI_AUTOTICK_CARDINALITY/);
  assert.throws(()=>isolateWindowsAutotickRegression(original+' && node --test --test-concurrency=1 '+file),/CI_AUTOTICK_CARDINALITY/);
  const code=read('tools/run-bounded-test-script.mjs');
  assert.ok(code.includes('command=isolateWindowsAutotickRegression(command);'));
});

test('hosted Windows priority mode runs scheduler-sensitive isolated fixtures before the bulk qualification batch',()=>{
  const pkg=JSON.parse(read('package.json'));
  for(const scriptName of ['check','test']){
    const bounded=boundNodeTestConcurrency(pkg.scripts[scriptName],1).command;
    const prioritized=prioritizeSensitiveQualificationCommands(bounded);
    const bulkIndex=prioritized.indexOf('test/boot-recovery-diagnostics.test.mjs');
    assert.ok(bulkIndex>0,'bulk qualification command must remain present');
    const ordered=['test/mcp-tasks-extension.test.mjs','test/tunnel-log-rotation.test.mjs','test/async-operations.test.mjs','test/workflow-http.test.mjs'];
    const positions=ordered.map(sensitive=>prioritized.indexOf(sensitive));
    for(let i=0;i<ordered.length;i++) assert.ok(positions[i]>=0 && positions[i]<bulkIndex, ordered[i]+' must execute before bulk qualification');
    assert.ok(positions.every((position,index)=>index===0||positions[index-1]<position), 'sensitive fixtures must preserve deterministic priority order');
  }
});


test('R232 Windows isolated lease fixture executes once before bulk without a relaxed timeout',()=>{
  const pkg=JSON.parse(read('package.json'));
  const bounded=boundNodeTestConcurrency(pkg.scripts.test,1).command;
  const ordered=prioritizeSensitiveQualificationCommands(bounded);
  const isolated=isolateWindowsLeaseRegression(ordered);
  const target='test/project-engine-integration.test.mjs';
  const leader='node --test --test-concurrency=1 '+target+' && ';
  assert.ok(isolated.startsWith(leader),'sensitive regression must start in a dedicated process');
  assert.equal(isolated.split(target).length-1,1,'never skip or repeat the lease-regression file');
  assert.equal(isolated,leader+ordered.replace(' '+target,''),'no other qualification test or command may change');
  assert.ok(isolated.indexOf('test/mcp-tasks-extension.test.mjs')>leader.length,'other isolated fixtures remain covered');
  const code=read('tools/run-bounded-test-script.mjs');
  assert.ok(code.includes("if(args.script==='test'&&process.platform==='win32'){") &&
    code.includes("command=isolateWindowsLeaseRegression(command);") &&
    code.includes("command=isolateWindowsTimingSensitiveRegressions(command);"));
  assert.throws(()=>isolateWindowsLeaseRegression('node --test --test-concurrency=1 test/other.test.mjs'),/CI_LEASE_TEST_CARDINALITY/);
  assert.throws(()=>isolateWindowsLeaseRegression(leader+leader+ordered),/CI_LEASE_TEST_CARDINALITY/);
});


test('R468 dedicated Windows timing-sensitive project fixtures run once before bulk without relaxing test deadlines',()=>{
  const pkg=JSON.parse(read('package.json'));
  const ordered=prioritizeSensitiveQualificationCommands(boundNodeTestConcurrency(pkg.scripts.test,1).command);
  const lease=isolateWindowsLeaseRegression(ordered);
  const result=isolateWindowsTimingSensitiveRegressions(lease);
  const files=['test/project-adaptive.test.mjs','test/project-delivery-correlation.test.mjs','test/project-engine-review.test.mjs','test/project-engine.test.mjs'];
  const prefix=files.map(f=>'node --test --test-concurrency=1 '+f).join(' && ')+' && ';
  const expected=prefix+files.reduce((command,file)=>command.replace(' '+file,''),lease);
  assert.equal(result,expected,'only scheduling changes; full original tests retained');
  assert.ok(result.startsWith(prefix));
  assert.equal(result.split('node --test --test-concurrency=1 ').length-1,
    lease.split('node --test --test-concurrency=1 ').length-1+files.length);
  for(const file of files)assert.equal(result.split(file).length-1,1,'no duplicate, skip or rerun '+file);
  for(const file of files)assert.throws(
    ()=>isolateWindowsTimingSensitiveRegressions(lease.replace(' '+file,'')),
    /CI_WINDOWS_TIMING_CARDINALITY/
  );
  assert.throws(()=>isolateWindowsTimingSensitiveRegressions(prefix+lease),/CI_WINDOWS_TIMING_CARDINALITY/);
  const runner=read('tools/run-bounded-test-script.mjs');
  assert.ok(runner.includes('command=isolateWindowsLeaseRegression(command);'));
  assert.ok(runner.includes('command=isolateWindowsTimingSensitiveRegressions(command);'));
  // The underlying business logic and per-test timeouts are intentionally unchanged.
  const projectEngineSource=read('test/project-engine.test.mjs');
  assert.ok(projectEngineSource.indexOf("test('human WAITING_INPUT time does not consume the execution deadline'") <
    projectEngineSource.indexOf("test('real filesystem operation"), 'WAITING_INPUT timer must run before loaded fixture tests');
  assert.ok(projectEngineSource.includes('durationMs:1000') && projectEngineSource.includes('setTimeout(resolve,1100)'),
    'strict original short execution duration and waiting interval must remain unchanged');
  assert.ok(read('test/project-adaptive.test.mjs').includes("{ timeout: 6000 }"));
  assert.ok(read('test/project-delivery-correlation.test.mjs').includes('maxDurationMs:10000'));
});


test('R492 Windows process-tree regression is isolated exactly once with unchanged deadline and full test coverage',()=>{
  const pkg=JSON.parse(read('package.json'));
  const bounded=boundNodeTestConcurrency(pkg.scripts.test,1).command;
  const prioritized=prioritizeSensitiveQualificationCommands(bounded);
  const lease=isolateWindowsLeaseRegression(prioritized);
  const timed=isolateWindowsTimingSensitiveRegressions(lease);
  const isolated=isolateWindowsProcessTreeRegression(timed);
  const name='test/process-tree-lifecycle.test.mjs';
  const prefix='node --test --test-concurrency=1 '+name+' && ';
  assert.ok(isolated.startsWith(prefix));
  assert.equal(isolated.split(name).length-1,1);
  assert.equal(isolated,prefix+timed.replace(' '+name,''),'only scheduling changes');
  assert.ok(isolated.includes('test/boot-recovery-diagnostics.test.mjs'),'bulk coverage is retained');
  assert.throws(()=>isolateWindowsProcessTreeRegression(timed.replace(' '+name,'')),/CI_PROCESS_TREE_CARDINALITY/);
  assert.throws(()=>isolateWindowsProcessTreeRegression(prefix+timed),/CI_PROCESS_TREE_CARDINALITY/);
  assert.ok(read('test/process-tree-lifecycle.test.mjs').includes('{ timeout: 25000 }'),'native test deadline unchanged');
  const runner=read('tools/run-bounded-test-script.mjs');
  assert.ok(runner.includes("command=isolateWindowsProcessTreeRegression(command);"));
});

test('R500 Windows Agent Extension HTTP starts in its own bounded process, coverage unchanged',()=>{
  const pkg=JSON.parse(read('package.json'));
  const file='test/agent-extensions-http.test.mjs';
  const prefix='node --test --test-concurrency=1 '+file+' && ';
  for(const name of ['check','test']){
    const bounded=boundNodeTestConcurrency(pkg.scripts[name],1).command;
    const ordered=prioritizeSensitiveQualificationCommands(bounded);
    const isolated=isolateWindowsAgentHttpRegression(ordered);
    assert.ok(isolated.startsWith(prefix));
    assert.equal(isolated.split(file).length-1,1,'file executes exactly once');
    assert.equal(isolated,prefix+ordered.replace(' '+file,''),'no other command is changed');
    assert.throws(()=>isolateWindowsAgentHttpRegression(ordered.replace(' '+file,'')),/CI_AGENT_HTTP_CARDINALITY/);
    assert.throws(()=>isolateWindowsAgentHttpRegression(prefix+ordered),/CI_AGENT_HTTP_CARDINALITY/);
  }
  const runner=read('tools/run-bounded-test-script.mjs');
  assert.ok(runner.includes("if(process.platform==='win32') command=isolateWindowsAgentHttpRegression(command);"));
  assert.ok(read('test/agent-extensions-http.test.mjs').includes('for(let i=0;i<400;i++)'),'original native readiness budget preserved');
});

test('R470 sanitized diagnostic workflow persists no raw qualification log and keeps updater fail closed',()=>{
  const script=read('tools/diagnose-updater-gate-r470.ps1');
  const workflow=read('.github/workflows/windows-updater-e2e-r157.yml');
  for(const marker of [
    'failureTests','sourceSha256','matchingLogCount','rawLogIncluded=$false',
    'secretsIncluded=$false','UNSAFE_RERUN_DIAGNOSTIC_ALREADY_EXISTS',
    'LOG_TOO_LARGE','AMBIGUOUS_MULTIPLE_MATCHING_LOGS'
  ]) assert.ok(script.includes(marker),marker);
  for(const marker of [
    "if: ${{ failure() }}",
    "github.event.pull_request.head.repo.full_name == github.repository",
    "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    'retention-days: 7',
    'if-no-files-found: warn',
    'DIAGNOSTIC_R470.json',
    'runner.temp }}/remote-commander-updater-r157/DIAGNOSTIC_R470.json'
  ]) assert.ok(workflow.includes(marker),marker);
  assert.ok(!workflow.includes('env.RC_E2E_ROOT }}/DIAGNOSTIC_R470.json'),
    'workflow expression context cannot trust a runtime-generated GITHUB_ENV value');
  assert.ok(workflow.indexOf('R470 derive a bounded')>workflow.indexOf('Independently verify exact Job receipts'));
  assert.ok(!workflow.includes('upload-artifact@v3'));
  assert.ok(workflow.includes('-NoPromote'),'keep original tested production path unchanged');
});

test('R470 Windows fixture extracts failing test and counters without persisting secrets, and refuses ambiguous logs', t=>{
  if(process.platform!=='win32') return t.skip('PowerShell native fixture is Windows-only; static workflow guard runs on both systems');
  const script=path.join(root,'tools','diagnose-updater-gate-r470.ps1');
  const sha='604ed6a8a0e0f95197fabcc92d93537142017a0b';
  const secret='ghp_R470_TEST_SENTINEL_SUPER_SECRET_SHOULD_NOT_APPEAR';
  function run(names) {
    const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'rc-r470-diagnostic-'));
    try {
      const folder=path.join(tmp,'STATE','ChatGPTRemoteCommander','update-logs');
      fs.mkdirSync(folder,{recursive:true});
      for(const name of names)fs.writeFileSync(path.join(folder,name),
        ['TAP version 13','not ok 245 - team reserves all calls before workers and executes only the coordinator proposal',
        "failureType: 'testTimeoutFailure'",'code: ERR_TEST_FAILURE','# tests 521','# pass 520',
        '# fail 1','# cancelled 0','# duration_ms 25000','Authorization: Bearer '+secret].join('\n'),'utf8');
      const proc=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',script,
        '-Root',tmp,'-ExpectedCommit',sha],{encoding:'utf8',timeout:15000});
      assert.equal(proc.status,0,proc.stderr || proc.stdout);
      const report=fs.readFileSync(path.join(tmp,'DIAGNOSTIC_R470.json'),'utf8');
      assert.ok(!report.includes(secret),'never persist raw token or bearer value');
      assert.ok(!report.includes(tmp),'never persist machine path');
      return JSON.parse(report);
    } finally {fs.rmSync(tmp,{recursive:true,force:true});}
  }
  const file='qualification-output-qualification-test-'+sha.slice(0,12)+'-r470-fixture.stdout.log';
  const one=run([file]);
  assert.equal(one.status,'TAP_SUMMARY_EXTRACTED');
  assert.equal(one.matchingLogCount,1);
  assert.equal(one.failureTests[0].index,245);
  assert.ok(one.failureTests[0].publicTestName.startsWith('team reserves all calls'));
  assert.equal(one.tapCounts.fail,'1');
  assert.equal(one.tapCounts.pass,'520');
  assert.ok(one.failureTypes.includes('testTimeoutFailure'));
  assert.equal(one.rawLogIncluded,false);
  assert.equal(one.secretsIncluded,false);
  const many=run([file,file.replace('fixture','duplicate')]);
  assert.equal(many.status,'AMBIGUOUS_MULTIPLE_MATCHING_LOGS');
  assert.equal(many.failureTests.length,0,'never guess newest');
});

test('Windows async HTTP startup is isolated exactly once in both check and test without widening limits',()=>{
  const pkg=JSON.parse(read('package.json'));
  for(const scriptName of ['check','test']){
    const bounded=boundNodeTestConcurrency(pkg.scripts[scriptName],1);
    let before=prioritizeSensitiveQualificationCommands(bounded.command);
    before=isolateWindowsAgentHttpRegression(before);
    if(scriptName==='test'){
      before=isolateWindowsTimingSensitiveRegressions(before);
      before=isolateWindowsProcessTreeRegression(before);
      before=isolateWindowsTransferMeshHttpRegression(before);
      before=isolateWindowsLeaseRegression(before);
      before=isolateWindowsWorkflowPlanRegression(before);
    }
    const file='test/async-http.test.mjs';
    const leader='node --test --test-concurrency=1 '+file+' && ';
    const isolated=isolateWindowsAsyncHttpRegression(before);
    assert.equal(isolated,leader+before.replace(' '+file,''),'only move the existing test to a separate first command');
    assert.equal(isolated.split(file).length-1,1,'the full async HTTP test must run exactly once');
    assert.ok(isolated.includes('test/async-operations.test.mjs'),'existing async operation fixture remains covered');
    assert.ok(isolated.includes('test/agent-extensions-http.test.mjs'),'existing HTTP fixture remains covered');
    assert.throws(()=>isolateWindowsAsyncHttpRegression(isolated),/CI_ASYNC_HTTP_ISOLATION_INVALID/);
  }
  assert.throws(()=>isolateWindowsAsyncHttpRegression('node --test --test-concurrency=1 test/other.test.mjs'),/CI_ASYNC_HTTP_CARDINALITY/);
  assert.throws(()=>isolateWindowsAsyncHttpRegression('node --test --test-concurrency=1 test/async-http.test.mjs test/async-http.test.mjs'),/CI_ASYNC_HTTP_CARDINALITY/);
  const runner=read('tools/run-bounded-test-script.mjs');
  assert.ok(runner.includes("if(process.platform==='win32') command=isolateWindowsAsyncHttpRegression(command);"));
  assert.ok(runner.indexOf('command=isolateWindowsAsyncHttpRegression(command);') <
    runner.lastIndexOf('command=isolateWindowsTimingSensitiveRegressions(command);'),
    'strict deadline batch must be the final prepend in Windows test qualification');
  const fixture=read('test/async-http.test.mjs');
  assert.match(fixture,/attempt < 400/,'keep original fixed 400x25ms readiness budget');
  assert.match(fixture,/const deadline = Date[.]now\(\) \+ 15000/,'keep operation terminal observation deadline');
});

test('R157 qualifier markers are opt-in, index-only, and preserve all original commands',()=>{
  const sample='node --test test/a.test.mjs && node test/b.mjs';
  assert.equal(markIsolatedQualificationPhases(sample),
    'echo RC_QUAL_PHASE_START_00 && node --test test/a.test.mjs && echo RC_QUAL_PHASE_PASS_00 && '+
    'echo RC_QUAL_PHASE_START_01 && node test/b.mjs && echo RC_QUAL_PHASE_PASS_01');
  assert.throws(()=>markIsolatedQualificationPhases('echo untrusted command'),/R157_PHASE_COMMAND_SHAPE_INVALID/);
  const pkg=JSON.parse(read('package.json'));
  const bounded=boundNodeTestConcurrency(pkg.scripts.test,1);
  let command=prioritizeSensitiveQualificationCommands(bounded.command);
  command=isolateWindowsAgentHttpRegression(command);
  command=isolateWindowsProcessTreeRegression(command);
  command=isolateWindowsTransferMeshHttpRegression(command);
  command=isolateWindowsLeaseRegression(command);
  command=isolateWindowsAsyncHttpRegression(command);
  command=isolateWindowsTimingSensitiveRegressions(command);
  command=isolateWindowsWorkflowPlanRegression(command);
  const groups=command.split(' && ');
  assert.ok(groups[0].includes('test/workflow-plan.test.mjs'),'workflow-plan race runs first');
  assert.ok(groups[1].includes('test/project-adaptive.test.mjs'),'strict team timeout follows workflow-plan');
  assert.ok(groups[2].includes('test/project-delivery-correlation.test.mjs'));
  assert.ok(groups[3].includes('test/project-engine-review.test.mjs'));
  assert.ok(groups[4].includes('test/project-engine.test.mjs'),'WAITING_INPUT deadline regression runs in its own early process');
  assert.ok(groups[5].includes('test/async-http.test.mjs'),'async HTTP still runs ahead of high-volume batch');
  for(const file of ['test/project-adaptive.test.mjs','test/async-http.test.mjs'])
    assert.equal(command.split(file).length-1,1,'exactly one regression '+file);
  const marked=markIsolatedQualificationPhases(command);
  assert.ok(marked.length<7500,'preserve Windows cmd.exe length limit');
  assert.equal((marked.match(/RC_QUAL_PHASE_START_\d{2}/g)||[]).length,groups.length);
  assert.equal((marked.match(/RC_QUAL_PHASE_PASS_\d{2}/g)||[]).length,groups.length);
  for(const [index,part] of groups.entries()){
    assert.ok(marked.includes('RC_QUAL_PHASE_START_'+String(index).padStart(2,'0')+' && '+part+' && echo RC_QUAL_PHASE_PASS_'+String(index).padStart(2,'0')),
      'each exact original command is preserved in its own observed phase');
  }
  const wrapper=read('tools/run-bounded-test-script.mjs');
  assert.ok(wrapper.includes("process.env.RC_QUALIFICATION_RUN_ID"),'R157 opt-in is guarded');
  assert.ok(wrapper.includes('splitWindowsQualificationCommands(command)'));
});

test('Windows check gate isolates native HTTP startup groups without removing coverage',()=>{
  const pkg=JSON.parse(read('package.json'));
  let command=prioritizeSensitiveQualificationCommands(
    boundNodeTestConcurrency(pkg.scripts.check,1).command);
  command=isolateWindowsAgentHttpRegression(command);
  const original=command.split(' && ');
  const result=isolateWindowsStartupReadinessRegressions(command);
  const after=result.split(' && ');
  const cold=['test/workflow-http.test.mjs','test/browser-process.test.mjs',
    'test/transport-correlation-http.test.mjs'];
  assert.deepEqual(after.slice(0,3),cold.map(file=>
    'node --test --test-concurrency=1 '+file));
  for(const file of cold)assert.equal(result.split(file).length-1,1);
  assert.equal(after.length,original.length+2);
  for(const section of original)if(!cold.some(file=>section.includes(' '+file)))
    assert.ok(after.includes(section),'preserve every other check group');
  const runner=read('tools/run-bounded-test-script.mjs');
  assert.ok(runner.includes("if(process.platform==='win32'&&args.script==='check')"));
  assert.ok(runner.includes('command=isolateWindowsStartupReadinessRegressions(command);'));
  assert.equal(isolateWindowsStartupReadinessRegressions(result),result,
    'reapplying the exact independent scheduling is idempotent');
});

test('R157 isolates every owned Windows phase so total command length cannot defeat qualification',()=>{
  const original=Array.from({length:90},(_,i)=>'node --test test/phase-'+i+'-'+ 'x'.repeat(70)+'.test.mjs').join(' && ');
  assert.throws(()=>markIsolatedQualificationPhases(original),/R157_PHASE_WINDOWS_CMD_LENGTH/);
  const phases=splitWindowsQualificationCommands(original);
  assert.equal(phases.length,90);
  assert.deepEqual(phases,original.split(' && '));
  assert.ok(phases.every(part=>part.length<7000));
  assert.throws(()=>splitWindowsQualificationCommands('node test/a.mjs && echo untrusted'),/R157_PHASE_COMMAND_SHAPE_INVALID/);
  assert.throws(()=>splitWindowsQualificationCommands('node test/a.mjs && node '+ 'a'.repeat(7200)),/R157_PHASE_COMMAND_SHAPE_INVALID/);
  const wrapper=read('tools/run-bounded-test-script.mjs');
  assert.ok(wrapper.includes("console.log('RC_QUAL_PHASE_START_'+marker)"));
  assert.ok(wrapper.includes("console.log('RC_QUAL_PHASE_PASS_'+marker)"));
  assert.ok(wrapper.includes("if(phase.status!==0){process.exitCode="),'failure must stop subsequent tests');
});

test('R470 does not misreport a non-TAP failure as a TAP summary; identifies only numeric phase',t=>{
  if(process.platform!=='win32')return t.skip('native PowerShell fixture applies only to Windows');
  const sha='604ed6a8a0e0f95197fabcc92d93537142017a0b';
  const script=path.join(root,'tools','diagnose-updater-gate-r470.ps1');
  const secret='ghp_R470_DO_NOT_INCLUDE_SECRET';
  for(const [name,lines,status,index] of [
    ['marked',['RC_QUAL_PHASE_START_00','RC_QUAL_PHASE_PASS_00','RC_QUAL_PHASE_START_01',
      'Fatal: injected Windows private path C:\\Private\\User\\ ' +secret],'NON_TAP_FAILURE_PHASE_IDENTIFIED',1],
    ['unmarked',['fatal error without TAP and without phase markers '+secret],'NON_TAP_FAILURE_UNCLASSIFIED',null],
  ]){
    const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'rc-r470-nontap-'));
    try{
      const dir=path.join(tmp,'STATE','ChatGPTRemoteCommander','update-logs');
      fs.mkdirSync(dir,{recursive:true});
      fs.writeFileSync(path.join(dir,'qualification-output-qualification-test-'+sha.slice(0,12)+'-'+name+'.stdout.log'),lines.join('\n'),'utf8');
      const proc=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',script,'-Root',tmp,
        '-ExpectedCommit',sha],{encoding:'utf8',timeout:15000});
      assert.equal(proc.status,0,proc.stderr||proc.stdout);
      const raw=fs.readFileSync(path.join(tmp,'DIAGNOSTIC_R470.json'),'utf8');
      assert.ok(!raw.includes(secret),'raw secret must not appear in artifact');
      assert.ok(!raw.includes(tmp),'absolute local path must not appear in artifact');
      const report=JSON.parse(raw);
      assert.equal(report.status,status);
      assert.equal(report.failurePhaseIndex,index);
      assert.equal(report.failureTests.length,0);
      assert.equal(report.rawLogIncluded,false);
    }finally{fs.rmSync(tmp,{recursive:true,force:true});}
  }
});

test('R470 Node24 spec reporter failure is classified and sanitized with no raw user paths',t=>{
  if(process.platform!=='win32')return t.skip('requires native Windows PowerShell');
  const sha='604ed6a8a0e0f95197fabcc92d93537142017a0b';
  const secret='ghp_TEST_SECRET_NOT_TO_PERSIST';
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'rc-r470-spec-'));
  try{
    const dir=path.join(tmp,'STATE','ChatGPTRemoteCommander','update-logs');
    fs.mkdirSync(dir,{recursive:true});
    const lines=['✖ R157 harmless formatting probe (1.8478ms)','ℹ tests 1','ℹ suites 0',
      'ℹ pass 0','ℹ fail 1','ℹ duration_ms 144.5914','✖ failing tests:',
      '✖ R157 harmless formatting probe (1.8478ms)',
      'at C:\\Users\\Private\\report '+secret];
    fs.writeFileSync(path.join(dir,'qualification-output-qualification-test-'+sha.slice(0,12)+'-spec.stdout.log'),
      lines.join('\n'),'utf8');
    const script=path.join(root,'tools','diagnose-updater-gate-r470.ps1');
    const proc=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',script,'-Root',tmp,
      '-ExpectedCommit',sha],{encoding:'utf8',timeout:15000});
    assert.equal(proc.status,0,proc.stderr||proc.stdout);
    const raw=fs.readFileSync(path.join(tmp,'DIAGNOSTIC_R470.json'),'utf8');
    assert.ok(!raw.includes(secret));
    assert.ok(!raw.includes(tmp));
    const report=JSON.parse(raw);
    assert.equal(report.status,'SPEC_SUMMARY_EXTRACTED');
    assert.deepEqual(report.specFailureTests,['R157 harmless formatting probe']);
    assert.equal(report.specCounts.tests,'1');
    assert.equal(report.specCounts.fail,'1');
    assert.equal(report.failurePhaseIndex,null);
    assert.equal(report.rawLogIncluded,false);
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

test('R173 V025W diagnostic uses distinct scope, hashed synthetic spec and artifact without leaking logs',t=>{
  if(process.platform!=='win32')return t.skip('requires native Windows PowerShell');
  const sha='604ed6a8a0e0f95197fabcc92d93537142017a0b';
  const secret='ghp_R173_SENSITIVE_SENTINEL_NEVER_PERSIST';
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'r173-v025-r470-'));
  try{
    const folder=path.join(tmp,'STATE','ChatGPTRemoteCommander','update-logs');
    fs.mkdirSync(folder,{recursive:true});
    const log=path.join(folder,'qualification-output-qualification-test-'+sha.slice(0,12)+'-fixture.stdout.log');
    fs.writeFileSync(log,[
      '✖ synthetic rollback test failure (3.14ms)',
      'ℹ tests 1','ℹ pass 0','ℹ fail 1',
      'at C:\\Private\\Owner\\location '+secret
    ].join('\n'),'utf8');
    const tool=path.join(root,'tools','diagnose-updater-gate-r470.ps1');
    const scope='READ_ONLY_HOSTED_V025W_ROLLBACK_QUALIFICATION_FAILURE';
    const proc=spawnSync('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',
      tool,'-Root',tmp,'-ExpectedCommit',sha,'-Scope',scope],
      {encoding:'utf8',timeout:15000});
    assert.equal(proc.status,0,proc.stderr||proc.stdout);
    const artifact=fs.readFileSync(path.join(tmp,'DIAGNOSTIC_R470.json'),'utf8');
    assert.ok(!artifact.includes(secret),'do not publish raw secrets');
    assert.ok(!artifact.includes(tmp),'do not publish private paths');
    const report=JSON.parse(artifact);
    assert.equal(report.status,'SPEC_SUMMARY_EXTRACTED');
    assert.equal(report.scope,scope);
    assert.equal(report.commit,sha);
    assert.equal(report.matchingLogCount,1);
    assert.equal(report.historicalFailureJob,null);
    assert.deepEqual(report.specFailureTests,['synthetic rollback test failure']);
    assert.equal(report.specCounts.fail,'1');
    assert.equal(report.rawLogIncluded,false);
    assert.equal(report.secretsIncluded,false);
    assert.equal(report.absolutePathsIncluded,false);
    const rollback=read('test/release-rollback-windows-v01025.ps1');
    assert.ok(rollback.includes("-Scope '"+scope+"'"));
    assert.ok(rollback.includes('V025W_R470_READBACK_MISMATCH'));
    for(const wf of ['.github/workflows/release-rollback-windows-r173.yml',
      '.github/workflows/candidate-rollback-v01025.yml']){
      assert.ok(read(wf).includes('remote-commander-rollback-v025w/DIAGNOSTIC_R470.json'),
        'only sanitized diagnostic receipt may be uploaded: '+wf);
    }
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

test('Windows runs exact workflow-plan races before loaded CI; strict adaptive team deadline unchanged',()=>{
  const pkg=JSON.parse(read('package.json'));
  let command=prioritizeSensitiveQualificationCommands(boundNodeTestConcurrency(pkg.scripts.test,1).command);
  command=isolateWindowsAgentHttpRegression(command);
  command=isolateWindowsTimingSensitiveRegressions(command);
  command=isolateWindowsProcessTreeRegression(command);
  command=isolateWindowsTransferMeshHttpRegression(command);
  command=isolateWindowsLeaseRegression(command);
  const prior=command, file='test/workflow-plan.test.mjs';
  command=isolateWindowsWorkflowPlanRegression(command);
  assert.ok(command.startsWith('node --test --test-concurrency=1 '+file+' && '),'exact concurrency file is first');
  assert.equal(command.split(file).length-1,1,'original workflow-plan tests still run exactly once');
  assert.equal(command.replace('node --test --test-concurrency=1 '+file+' && ','').split(' && ').length,
    prior.split(' && ').length,'one isolated command replaces one file inside the original batch');
  assert.ok(command.includes('test/project-adaptive.test.mjs'));
  assert.ok(command.includes('test/project-engine-integration.test.mjs'));
  assert.ok(command.includes('test/boot-recovery-diagnostics.test.mjs'));
  assert.throws(()=>isolateWindowsWorkflowPlanRegression(prior.replace(' '+file,'')),/CI_WORKFLOW_PLAN_CARDINALITY/);
  const marked=markIsolatedQualificationPhases(command);
  assert.ok(marked.length<7500,'bounded R157 Windows shell command with phase markers');
  const source=read('test/project-adaptive.test.mjs');
  const first=source.indexOf("  test('inspect, extend, read prerequisite");
  const team=source.indexOf("  test('team reserves all calls before workers");
  assert.ok(team>0 && first>team,'strict six-second team regression runs before crash workers');
  assert.equal(source.split("test('team reserves all calls before workers").length-1,1);
  assert.ok(source.includes("test('team reserves all calls before workers and executes only the coordinator proposal', { timeout: 6000 }"),
    'preserve its exact original timeout');
});

test('Windows short-deadline team reservation runs before process-tree and HTTP load without skipped tests',()=>{
 const pkg=JSON.parse(read('package.json'));
 const original=prioritizeSensitiveQualificationCommands(
   boundNodeTestConcurrency(pkg.scripts.test,1).command);
 let command=isolateWindowsAgentHttpRegression(original);
 command=isolateWindowsProcessTreeRegression(command);
 command=isolateWindowsTransferMeshHttpRegression(command);
 command=isolateWindowsLeaseRegression(command);
 command=isolateWindowsTimingSensitiveRegressions(command);
 command=isolateWindowsWorkflowPlanRegression(command);
 const commands=command.split(' && ');
 const files=['test/workflow-plan.test.mjs','test/project-adaptive.test.mjs',
   'test/process-tree-lifecycle.test.mjs','test/transfer-mesh-http.test.mjs'];
 const positions=files.map(file=>commands.findIndex(part=>part.includes(' '+file)));
 assert.deepEqual(positions.slice(0,2),[0,1],'workflow-plan and deadline-sensitive team fixture first');
 assert.ok(positions[1]<positions[2]&&positions[1]<positions[3],
   'short team budget must precede expensive owned child-process fixtures');
 for(const file of files)assert.equal(command.split(file).length-1,1,'no skipped or repeated '+file);
 const src=read('tools/run-bounded-test-script.mjs');
 assert.ok(src.indexOf('command=isolateWindowsTimingSensitiveRegressions(command);')>
   src.indexOf('command=isolateWindowsLeaseRegression(command);'));
 assert.ok(src.indexOf('command=isolateWindowsWorkflowPlanRegression(command);')>
   src.indexOf('command=isolateWindowsTimingSensitiveRegressions(command);'));
 assert.ok(read('test/project-adaptive.test.mjs').includes(
   "test('team reserves all calls before workers and executes only the coordinator proposal', { timeout: 6000 }"));
});

test('CI Windows runs the Transfer Mesh HTTP fixture alone without weakening readiness or dropping coverage',()=>{
  const pkg=JSON.parse(read('package.json'));
  const original=prioritizeSensitiveQualificationCommands(boundNodeTestConcurrency(pkg.scripts.test,1).command);
  const agent=isolateWindowsAgentHttpRegression(original);
  const timed=isolateWindowsTimingSensitiveRegressions(agent);
  const tree=isolateWindowsProcessTreeRegression(timed);
  const transfer=isolateWindowsTransferMeshHttpRegression(tree);
  const result=isolateWindowsLeaseRegression(transfer);
  const file='test/transfer-mesh-http.test.mjs',leader='node --test --test-concurrency=1 '+file+' && ';
  const scheduler='test/project-engine-integration.test.mjs';
  const schedulerLeader='node --test --test-concurrency=1 '+scheduler+' && ';
  assert.equal(transfer,leader+tree.replace(' '+file,''),'transfer scheduling only; all other tests unchanged');
  assert.equal(result,schedulerLeader+transfer.replace(' '+scheduler,''),'scheduler scheduling only');
  assert.ok(result.startsWith(schedulerLeader+leader),'bounded scheduler and HTTP fixture run first');
  assert.equal(result.split(file).length-1,1,'single execution is retained');
  assert.equal(result.split(scheduler).length-1,1,'scheduler executes exactly once');
  assert.ok(result.includes('test/transfer-mesh-native.test.mjs'),'native transfer coverage stays enabled');
  assert.ok(result.includes('tools/commander-transfer-mesh/pilot-cli.test.mjs'));
  assert.ok(result.indexOf(file)<result.indexOf('test/transfer-mesh-native.test.mjs'),
    'HTTP fixture is separated before the high-volume transfer group');
  assert.throws(()=>isolateWindowsTransferMeshHttpRegression(tree.replace(' '+file,'')),
    /CI_TRANSFER_HTTP_CARDINALITY/);
  assert.throws(()=>isolateWindowsTransferMeshHttpRegression(leader+tree),
    /CI_TRANSFER_HTTP_CARDINALITY/);
  const wrapper=read('tools/run-bounded-test-script.mjs');
  assert.ok(wrapper.includes("command=isolateWindowsTransferMeshHttpRegression(command);"));
  assert.ok(wrapper.indexOf('command=isolateWindowsLeaseRegression(command);')>
    wrapper.indexOf('command=isolateWindowsTransferMeshHttpRegression(command);'),
    'last composed prefix is scheduled first; no additional test runs or deadlines');
  const fixture=read('test/transfer-mesh-http.test.mjs');
  assert.ok(fixture.includes('for(let i=0;i<200;i++)'),'same bounded readiness budget');
  assert.ok(fixture.includes('await wait(25)'),'same server-readiness poll');
  assert.ok(fixture.includes('assert.equal(healthy,true,stderr)'),'still fail closed if server cannot start');
});


test('concurrency smoke reserves an OS-assigned port per run with unique owned roots',()=>{
 const src=read('test/concurrency-smoke.mjs');
 assert.match(src,/reservation\.listen\(0,'127\.0\.0\.1',resolve\)/);
 assert.match(src,/const instanceId = randomUUID\(\);/);
 assert.match(src,/\.tmp-concurrency-root-' \+ instanceId/);
 assert.match(src,/\.tmp-concurrency-app-' \+ instanceId/);
 assert.match(src,/reservation\.close\(err=>err\?reject\(err\):resolve\(\)\)/);
 assert.doesNotMatch(src,/const port\s*=\s*47931/);
 assert.match(src,/liveRuntimeStateAfter,[\s\S]*liveRuntimeStateBefore/);
});


test('R157 Windows dual-era MCP server conformance executes once early, unchanged coverage',()=>{
  const pkg=JSON.parse(read('package.json'));
  const original=prioritizeSensitiveQualificationCommands(boundNodeTestConcurrency(pkg.scripts.test,1).command);
  const before=isolateWindowsWorkflowPlanRegression(
    isolateWindowsTimingSensitiveRegressions(
      isolateWindowsAsyncHttpRegression(
        isolateWindowsLeaseRegression(
          isolateWindowsTransferMeshHttpRegression(
            isolateWindowsProcessTreeRegression(
              isolateWindowsAgentHttpRegression(original)))))));
  const file='test/mcp-conformance.test.mjs';
  const prefix='node --test --test-concurrency=1 '+file+' && ';
  const isolated=isolateWindowsMcpConformanceRegression(before);
  assert.equal(isolated,prefix+before.replace(' '+file,''),
    'only move original test file, preserving all other commands');
  assert.equal(isolated.split(file).length-1,1,'no skipped, duplicated or repeated test');
  assert.ok(isolated.includes('test/workflow-plan.test.mjs'));
  assert.ok(isolated.includes('test/agent-extensions.test.mjs'),
    'preserve unrelated existing bulk qualification coverage');
  assert.ok(markIsolatedQualificationPhases(isolated).length<7500,
    'R157 Windows cmd.exe phase-marked bound stays unchanged');
  assert.throws(()=>isolateWindowsMcpConformanceRegression(before.replace(' '+file,'')),
    /CI_MCP_CONFORMANCE_CARDINALITY/);
  assert.throws(()=>isolateWindowsMcpConformanceRegression(prefix+before),
    /CI_MCP_CONFORMANCE_CARDINALITY/);
  assert.ok(read('tools/run-bounded-test-script.mjs').includes(
    'command=isolateWindowsMcpConformanceRegression(command);'));
  assert.match(read('test/mcp-conformance.test.mjs'),/attempt < 400/,
    'original fixture readiness budget and body remain untouched');
});

test('strict Windows adaptive fixture is scheduled cold with all original groups intact',()=>{
  const pkg=JSON.parse(read('package.json'));
  let cmd=prioritizeSensitiveQualificationCommands(boundNodeTestConcurrency(pkg.scripts.test,1).command);
  cmd=isolateWindowsAgentHttpRegression(cmd);
  cmd=isolateWindowsProcessTreeRegression(cmd);
  cmd=isolateWindowsTransferMeshHttpRegression(cmd);
  cmd=isolateWindowsLeaseRegression(cmd);
  cmd=isolateWindowsAsyncHttpRegression(cmd);
  cmd=isolateWindowsTimingSensitiveRegressions(cmd);
  cmd=isolateWindowsWorkflowPlanRegression(cmd);
  cmd=isolateWindowsMcpConformanceRegression(cmd);
  const old=cmd.split(' && ');
  const target='node --test --test-concurrency=1 test/project-adaptive.test.mjs';
  assert.ok(old.indexOf(target)>0,'the historical strict test was behind prior fixture groups');
  const result=prioritizeWindowsAdaptiveCold(cmd);
  const next=result.split(' && ');
  assert.equal(next[0],target);
  assert.deepEqual(next.slice(1),old.filter(c=>c!==target),'no other group order or body changes');
  for(const c of old)assert.equal(next.filter(x=>x===c).length,old.filter(x=>x===c).length);
  assert.equal(markIsolatedQualificationPhases(result).match(/RC_QUAL_PHASE_START_/g).length,next.length);
  assert.throws(()=>prioritizeWindowsAdaptiveCold(result+' && '+target),/CI_COLD_ADAPTIVE_CARDINALITY/);
  assert.throws(()=>prioritizeWindowsAdaptiveCold('node --test test/project-adaptive.test.mjs'),/CI_COLD_ADAPTIVE_NOT_ISOLATED/);
  assert.throws(()=>prioritizeWindowsAdaptiveCold('node --test test/other.test.mjs'),/CI_COLD_ADAPTIVE_CARDINALITY/);
  assert.ok(read('test/project-adaptive.test.mjs').includes("{ timeout: 6000 }"),'original strict test deadline unchanged');
  assert.ok(read('tools/run-bounded-test-script.mjs').includes('command=prioritizeWindowsAdaptiveCold(command);'));
});


test('Windows startup-sensitive HTTP fixtures stay exact, early, and individually isolated',()=>{
  const pkg=JSON.parse(read('package.json'));
  const original=prioritizeSensitiveQualificationCommands(boundNodeTestConcurrency(pkg.scripts.test,1).command);
  let before=isolateWindowsAgentHttpRegression(original);
  before=isolateWindowsProcessTreeRegression(before);
  before=isolateWindowsTransferMeshHttpRegression(before);
  before=isolateWindowsLeaseRegression(before);
  before=isolateWindowsAsyncHttpRegression(before);
  before=isolateWindowsTimingSensitiveRegressions(before);
  before=isolateWindowsWorkflowPlanRegression(before);
  before=isolateWindowsMcpConformanceRegression(before);
  const names=['test/workflow-http.test.mjs','test/browser-process.test.mjs','test/transport-correlation-http.test.mjs'];
  const after=isolateWindowsStartupReadinessRegressions(before);
  const expected=names.map(file=>'node --test --test-concurrency=1 '+file).join(' && ')+' && ';
  assert.ok(after.startsWith(expected));
  const files=cmd=>(cmd.match(/test\/[A-Za-z0-9_.-]+\.test\.mjs/g)||[]).sort();
  assert.deepEqual(files(after),files(before),'not a single test file is added or lost');
  for(const file of names){
    assert.equal(after.split(file).length-1,1,'one invocation of '+file);
    assert.throws(()=>isolateWindowsStartupReadinessRegressions(before.replace(' '+file,'')),
      /CI_STARTUP_READINESS_CARDINALITY/);
    assert.throws(()=>isolateWindowsStartupReadinessRegressions('node --test --test-concurrency=1 '+file+' && '+before),
      /CI_STARTUP_READINESS_CARDINALITY/);
  }
  const cold=prioritizeWindowsAdaptiveCold(after).split(' && ');
  assert.equal(cold[0],'node --test --test-concurrency=1 test/project-adaptive.test.mjs');
  assert.deepEqual(cold.slice(1,4),names.map(file=>'node --test --test-concurrency=1 '+file));
  assert.ok(read('test/transport-correlation-http.test.mjs').includes('30000'),
    'host regression preserves the original 30-second readiness deadline');
  assert.ok(read('tools/run-bounded-test-script.mjs').includes(
    'command=isolateWindowsStartupReadinessRegressions(command);'));
});
