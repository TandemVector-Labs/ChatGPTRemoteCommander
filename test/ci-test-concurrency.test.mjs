import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundNodeTestConcurrency, parseQualificationArgs, prioritizeSensitiveQualificationCommands, isolateWindowsLeaseRegression, isolateWindowsTimingSensitiveRegressions, isolateWindowsProcessTreeRegression, isolateWindowsAgentHttpRegression, isolateWindowsTransferMeshHttpRegression, isolateWindowsWorkflowPlanRegression, isolateWindowsAsyncHttpRegression, isolateWindowsMcpConformanceRegression, isolateWindowsAutotickRegression, isolateWindowsStartupReadinessRegressions, prioritizeWindowsAdaptiveCold, markIsolatedQualificationPhases, splitWindowsQualificationCommands, parseQualificationPhase } from '../tools/run-bounded-test-script.mjs';

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
  assert.ok(read('test/project-adaptive.test.mjs').includes("{ timeout: 120000 }"));
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
  const helper=read('tools/run-r157-standard-user.ps1');
  assert.ok(workflow.includes('run-r157-standard-user.ps1') && helper.includes('-NoPromote'),'keep original tested production path unchanged');
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
        ['TAP version 13','R157_ASYNC_HTTP_TOKEN_PROBE={"ok":false,"isAdmin":false,"isSystem":false,"elevation":null,"source":null,"code":"WINDOWS_TOKEN_PROBE_FAILED"}','R157_ASYNC_HTTP_QUARANTINE=true','R157_ASYNC_HTTP_FAILURE_PHASE=operation-start','R157_ASYNC_HTTP_FAILURE_NAME=AssertionError','R157_ASYNC_HTTP_FAILURE_CODE=ERR_ASSERTION','R157_ASYNC_HTTP_SERVER_STARTUP={"exitCode":1,"signalCode":null,"stderrClass":"ERR_MODULE_NOT_FOUND","stderrBytes":120,"stdoutBytes":0}','R157_MCP_TASKS_LONG_POLL_STATUS=QUEUED',
        'R157_MCP_TASKS_LONG_POLL_ELAPSED_MS=1500','R157_MCP_TASKS_FAILURE_PHASE=task-terminal',
        'R157_MCP_TASKS_FAILURE_NAME=AssertionError',
        'R157_MCP_TASKS_FAILURE_CODE=ERR_ASSERTION',
        'R157_MCP_TASKS_FAILURE_ASSERTION={"operator":"strictEqual","actual":"FAILED","expected":"SUCCEEDED"}','not ok 245 - team reserves all calls before workers and executes only the coordinator proposal',
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
  assert.equal(one.failedGate,'test');
  assert.equal(one.matchingLogCount,1);
  assert.equal(one.failureTests[0].index,245);
  assert.ok(one.failureTests[0].publicTestName.startsWith('team reserves all calls'));
  assert.equal(one.tapCounts.fail,'1');
  assert.equal(one.tapCounts.pass,'520');
  assert.ok(one.failureTypes.includes('testTimeoutFailure'));
  assert.equal(one.rawLogIncluded,false);
  assert.equal(one.nativeTokenProbe.ok,false);
  assert.equal(one.nativeTokenProbe.code,'WINDOWS_TOKEN_PROBE_FAILED');
  assert.equal(one.httpPrivilegedLegacyHttpQuarantined,true);
  assert.equal(one.asyncHttpFailurePhase,'operation-start');
  assert.equal(one.asyncHttpFailureName,'AssertionError');
  assert.equal(one.asyncHttpFailureCode,'ERR_ASSERTION');
  assert.equal(one.asyncHttpServerStartup.stderrClass,'ERR_MODULE_NOT_FOUND');
  assert.equal(one.asyncHttpServerStartup.exitCode,1);
  assert.equal(one.asyncHttpServerStartup.stderrBytes,120);
  assert.equal(one.mcpTasksFailurePhase,'task-terminal');
  assert.equal(one.mcpTasksLongPollStatus,'QUEUED');
  assert.equal(one.mcpTasksLongPollElapsedMs,1500);
  assert.equal(one.mcpTasksFailureName,'AssertionError');
  assert.equal(one.mcpTasksFailureCode,'ERR_ASSERTION');
  assert.equal(one.mcpTasksFailureAssertion.operator,'strictEqual');
  assert.equal(one.mcpTasksFailureAssertion.actual,'FAILED');
  assert.equal(one.mcpTasksFailureAssertion.expected,'SUCCEEDED');
  // In hosted R157, the first failing gate can be check with no test log.
  const checkOnly=run([file.replace('qualification-test-','qualification-check-')]);
  assert.equal(checkOnly.failedGate,'check');
  assert.equal(checkOnly.status,'TAP_SUMMARY_EXTRACTED');
  assert.equal(checkOnly.matchingLogCount,1);
  assert.equal(checkOnly.failureTests[0].index,245);
  assert.equal(checkOnly.rawLogIncluded,false);
  const completedCheckPlusFailedTest=run([file,file.replace('qualification-test-','qualification-check-')]);
  assert.equal(completedCheckPlusFailedTest.failedGate,'test');
  assert.equal(completedCheckPlusFailedTest.matchingLogCount,1);
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
    'echo RC_QUAL_PHASE_START_00&&node --test test/a.test.mjs&&echo RC_QUAL_PHASE_PASS_00&&'+
    'echo RC_QUAL_PHASE_START_01&&node test/b.mjs&&echo RC_QUAL_PHASE_PASS_01');
  assert.throws(()=>markIsolatedQualificationPhases('echo untrusted command'),/R157_PHASE_COMMAND_SHAPE_INVALID/);
  const nested='node --test test/a.test.mjs && npm run test:v1-01-hybrid-oauth';
  assert.ok(markIsolatedQualificationPhases(nested).includes(
    'RC_QUAL_PHASE_START_01&&npm run test:v1-01-hybrid-oauth&&echo RC_QUAL_PHASE_PASS_01'));
  assert.throws(()=>markIsolatedQualificationPhases('node --test test/a.test.mjs && npm run arbitrary'),
    /R157_PHASE_COMMAND_SHAPE_INVALID/);
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
  assert.ok(marked.length<7550,'preserve Windows cmd.exe length limit');
  assert.equal((marked.match(/RC_QUAL_PHASE_START_\d{2}/g)||[]).length,groups.length);
  assert.equal((marked.match(/RC_QUAL_PHASE_PASS_\d{2}/g)||[]).length,groups.length);
  for(const [index,part] of groups.entries()){
    assert.ok(marked.includes('RC_QUAL_PHASE_START_'+String(index).padStart(2,'0')+'&&'+part+'&&echo RC_QUAL_PHASE_PASS_'+String(index).padStart(2,'0')),
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
  const cold=['test/conversation-http.test.mjs','test/workflow-http.test.mjs','test/browser-process.test.mjs',
    'test/transport-correlation-http.test.mjs'];
  assert.deepEqual(after.slice(0,4),cold.map(file=>
    'node --test --test-concurrency=1 '+file));
  for(const file of cold)assert.equal(result.split(file).length-1,1);
  assert.equal(after.length,original.length+3);
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
  assert.throws(()=>splitWindowsQualificationCommands('node test/a.mjs && npm run arbitrary'),/R157_PHASE_COMMAND_SHAPE_INVALID/);
  assert.throws(()=>splitWindowsQualificationCommands('node test/a.mjs && node '+ 'a'.repeat(7200)),/R157_PHASE_COMMAND_SHAPE_INVALID/);
  assert.throws(()=>splitWindowsQualificationCommands(Array.from({length:161},()=> 'node test/a.mjs').join(' && ')),
    /R157_PHASE_COMMAND_SHAPE_INVALID/);
  const wrapper=read('tools/run-bounded-test-script.mjs');
  assert.ok(wrapper.includes("const phases=process.platform==='win32'?splitWindowsQualificationCommands(command):null;"),
    'both Windows check and test chains are split automatically');
  assert.ok(wrapper.includes("if(process.env.RC_QUALIFICATION_RUN_ID)console.log('RC_QUAL_PHASE_START_'+marker);"),
    'numeric phase markers remain opt-in');
  assert.ok(wrapper.includes("if(process.env.RC_QUALIFICATION_RUN_ID)console.log('RC_QUAL_PHASE_PASS_'+marker);"));
  assert.ok(wrapper.includes("if(phase.status!==0){process.exitCode="),'failure must stop subsequent tests');
});

test('Windows check and test command chains accept only the exact nested package-script delegations',()=>{
  const pkg=JSON.parse(read('package.json'));
  let check=prioritizeSensitiveQualificationCommands(boundNodeTestConcurrency(pkg.scripts.check,1).command);
  check=isolateWindowsAgentHttpRegression(check);
  check=isolateWindowsStartupReadinessRegressions(check);
  check=isolateWindowsAsyncHttpRegression(check);
  const checkPhases=splitWindowsQualificationCommands(check);
  assert.equal(checkPhases.length,check.split(' && ').length);
  assert.ok(checkPhases.length>90,'Windows check chain exceeds the old single-test 90-phase ceiling');
  assert.ok(checkPhases.length<=160,'Windows check chain stays within the explicit phase bound');
  assert.ok(checkPhases.includes('npm run test:v1-01-worker-grants'));
  assert.ok(checkPhases.includes('npm run check:v1-01-hybrid-oauth'));
  let test=prioritizeSensitiveQualificationCommands(boundNodeTestConcurrency(pkg.scripts.test,1).command);
  test=isolateWindowsAgentHttpRegression(test);
  test=isolateWindowsProcessTreeRegression(test);
  test=isolateWindowsTransferMeshHttpRegression(test);
  test=isolateWindowsLeaseRegression(test);
  test=isolateWindowsAsyncHttpRegression(test);
  test=isolateWindowsTimingSensitiveRegressions(test);
  test=isolateWindowsWorkflowPlanRegression(test);
  test=isolateWindowsMcpConformanceRegression(test);
  test=isolateWindowsStartupReadinessRegressions(test);
  test=prioritizeWindowsAdaptiveCold(test);
  test=isolateWindowsAutotickRegression(test);
  const testPhases=splitWindowsQualificationCommands(test);
  assert.equal(testPhases.length,test.split(' && ').length);
  assert.ok(testPhases.includes('npm run test:v1-01-hybrid-oauth'));
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

test('Windows runs exact workflow-plan races before loaded CI; bounded adaptive team watchdog preserved',()=>{
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
  assert.ok(marked.length<7550,'bounded R157 Windows shell command with phase markers');
  const source=read('test/project-adaptive.test.mjs');
  const first=source.indexOf("  test('inspect, extend, read prerequisite");
  const team=source.indexOf("  test('team reserves all calls before workers");
  assert.ok(team>0 && first>team,'bounded team regression runs before crash workers');
  assert.equal(source.split("test('team reserves all calls before workers").length-1,1);
  assert.ok(source.includes("test('team reserves all calls before workers and executes only the coordinator proposal', { timeout: 120000 }"),
    'preserve bounded 20s timeout and unchanged assertions');
});

test('Windows bounded team reservation runs before process-tree and HTTP load without skipped tests',()=>{
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
   'team test must precede expensive owned child-process fixtures');
 for(const file of files)assert.equal(command.split(file).length-1,1,'no skipped or repeated '+file);
 const src=read('tools/run-bounded-test-script.mjs');
 assert.ok(src.indexOf('command=isolateWindowsTimingSensitiveRegressions(command);')>
   src.indexOf('command=isolateWindowsLeaseRegression(command);'));
 assert.ok(src.indexOf('command=isolateWindowsWorkflowPlanRegression(command);')>
   src.indexOf('command=isolateWindowsTimingSensitiveRegressions(command);'));
 assert.ok(read('test/project-adaptive.test.mjs').includes(
   "test('team reserves all calls before workers and executes only the coordinator proposal', { timeout: 120000 }"));
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
  assert.ok(fixture.includes('const startupDeadline=Date.now()+30000;'),'30-second wall-clock startup deadline');
  assert.ok(fixture.includes('signal:AbortSignal.timeout(300)'),'each health request remains bounded');
  assert.ok(fixture.includes('child.exitCode!==null||child.signalCode!==null'),'early child exit is diagnosed');
  assert.ok(fixture.includes(".slice(-8000)"),'stderr diagnostics remain bounded');
  assert.ok(fixture.includes('assert.equal(healthy,true,`transfer-mesh fixture did not become healthy within 30000ms; last=${lastHealthError}; stderr=${stderr}`)'),
    'still fail closed with bounded diagnostics if server cannot start');
  assert.ok(fixture.includes("assert.equal(health.instance.profile,'transfer-mesh-http-test')"),
    'readiness is tied to the exact isolated fixture, not another listener');
});


test('concurrency smoke reserves an OS-assigned port per run with unique owned roots',()=>{
 const src=read('test/concurrency-smoke.mjs');
 assert.match(src,/reservation\.listen\(0,'127\.0\.0\.1',resolve\)/);
 assert.match(src,/const instanceId = randomUUID\(\);/);
 assert.match(src,/const tempRoot = await mkdtemp\(path\.join\(tmpdir\(\), 'rc-concurrency-smoke-'\)\);/);
 assert.match(src,/const root = path\.join\(tempRoot, 'root-' \+ instanceId\);/);
 assert.match(src,/const isolatedApp = path\.join\(tempRoot, 'app-' \+ instanceId\);/);
 assert.match(src,/const configPath = path\.join\(tempRoot, 'config-' \+ instanceId \+ '\.json'\);/);
 assert.match(src,/await rm\(tempRoot, \{ recursive: true, force: true \}\);/);
 assert.ok(src.includes("process.once('exit'"));
 assert.ok(src.includes("rmSync(tempRoot, { recursive: true, force: true })"));
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
  assert.ok(markIsolatedQualificationPhases(isolated).length<7550,
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

test('bounded Windows adaptive fixture is scheduled cold with all original groups intact',()=>{
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
  assert.ok(read('test/project-adaptive.test.mjs').includes("{ timeout: 120000 }"),'bounded test deadline preserved');
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
  const names=['test/conversation-http.test.mjs','test/workflow-http.test.mjs','test/browser-process.test.mjs','test/transport-correlation-http.test.mjs'];
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
  assert.deepEqual(cold.slice(1,5),names.map(file=>'node --test --test-concurrency=1 '+file));
  assert.ok(read('test/conversation-http.test.mjs').includes('for(let i=0;i<400;i++)'),
    'conversation HTTP keeps its original 400x25ms readiness budget');
  assert.ok(read('test/transport-correlation-http.test.mjs').includes('30000'),
    'host regression preserves the original 30-second readiness deadline');
  assert.ok(read('tools/run-bounded-test-script.mjs').includes(
    'command=isolateWindowsStartupReadinessRegressions(command);'));
});


test('V1-01 identity lifecycle runs cold exactly once before the loaded source acceptance batch',()=>{
  const script=JSON.parse(read('package.json')).scripts['test:v1-01-worker-grants'];
  const target='test/v101-worker-identity-grant-adapter.test.mjs';
  const parts=script.split(' && ');
  const exact='node --test '+target;
  assert.equal(parts.filter(part=>part===exact).length,1,
    'the lifecycle fixture must have one independent Node test process');
  assert.equal(parts.filter(part=>part.startsWith('node --test ')&&part.includes(' '+target)&&part!==exact).length,0,
    'the loaded batch must not execute the fixture a second time');
  const coldIndex=parts.indexOf(exact);
  const bulkIndex=parts.findIndex(part=>part.startsWith('node --test ')&&part.includes('test/workflow-store.test.mjs'));
  assert.ok(coldIndex>=0&&bulkIndex>coldIndex,
    'lifecycle enrollment must be isolated before the large SQLite/worker batch');
  assert.ok(parts[bulkIndex].includes('test/worker-identity-authority.test.mjs'),
    'other worker authorization tests must retain their full coverage');
  assert.ok(parts[bulkIndex].includes('test/v101-owner-bound-router-bridge.test.mjs'),
    'native owner bridge authorization coverage must remain included');
});


test('V012 source regression retains every pinned test exactly once with bounded Windows phases',()=>{
  const runner=read('tools/run-v012-source-regression.mjs');
  const files=[...runner.matchAll(/^\s+"(test\/[^"]+\.mjs)",?$/gm)].map(match=>match[1]);
  const ranges=[...runner.matchAll(/files\.slice\((\d+),\s*(\d+)\)/g)]
    .map(match=>[Number(match[1]),Number(match[2])]);
  const scheduled=ranges.flatMap(([from,to])=>files.slice(from,to));
  assert.equal(files.length,30,'G1 private owner TLS/Core, native J01, signed pair Worker, encrypted worker-key provisioning, Windows host-name preflight, stream-safe consent, recovery and Linux tunnel observer stay source-pinned');
  assert.ok(files.includes('test/windows-owner-tunnel-host-resolution.test.mjs'),'native Windows read-only exact owner host regression must run in CI');
  assert.ok(files.includes('test/v012-owner-local-canary.test.mjs'),'real owner-local canary and failed-bootstrap quarantine must run in CI');
  assert.ok(files.includes('test/owner-pinned-provenance.test.mjs'),'owner-pinned unsigned candidate and rollback integrity must run in CI');
  assert.ok(files.includes('test/owner-dpapi-profile-recovery.test.mjs'),'native Windows DPAPI backup and tamper rejection must run in CI');
  assert.ok(files.includes('test/owner-systemd-creds-profile-recovery.test.mjs'),'native Linux systemd-creds backup and tamper rejection must run in CI');
  assert.ok(files.includes('test/native-owner-session-provider-linux.test.mjs'),'active Linux owner session and systemd service J01 must stay pinned to Source QA');
  assert.ok(files.includes('test/native-owner-dialog-streamsafe-contract.test.mjs'),'high-volume GTK stderr may not kill native owner consent or permit implicit approval');
  assert.ok(files.includes('test/local-ollama-planner.test.mjs'),'existing owner-local Ollama/llama.cpp planner adapter must run in source QA');
  assert.ok(files.includes('test/native-tunnel-client-observer-linux.test.mjs'),'same-owner PID/socket/poll real native Tunnel attestation must run in source QA');
  assert.ok(files.includes('test/v012-private-native-worker-adapter.test.mjs'),'native owner-pair no-OAuth signed Worker registration and revocation must run in source QA');
  assert.ok(files.includes('test/v012-private-owner-worker-key-provision.test.mjs'),'native owner-pinned worker-key credential stage, ACL and tamper rejection must remain in source QA');
  assert.ok(files.includes('test/qa-v012-no-promote-ingress.test.mjs'),'NoPromote negative-only qualification must run in CI');
  assert.equal(new Set(files).size,files.length,'no duplicate source fixture');
  assert.ok(ranges.length>=6,'native Windows fixture groups must remain bounded');
  assert.deepEqual(scheduled,files,'each fixture must execute exactly once and in original order');
  assert.deepEqual(ranges.slice(12,15),[[20,21],[21,22],[22,23]],
    'protected Core, Windows DPAPI and Linux owner recovery must not share a short subprocess deadline');
  assert.match(runner,/timeout: index === 13 \? 100000\s*: index === 14 \? \(part === 0 \? 55000 : 65000\)\s*: 30000/,
    'ordinary fixtures retain 30s, Windows DPAPI has a bounded 100s aggregate for its declared 30s/60s tests, Linux recovery has isolated 55/65s budgets');
  assert.ok(runner.includes('index === 14 ? linuxOwnerRecoveryTests.map(name =>'),
    'only the named Linux native credential tests may use separate bounded deadlines');
  for(const name of ['Linux native owner credential recovery stages idempotently, verifies isolated restore and rejects tampering',
    'profile-specific owner recovery capsules never share a Tunnel or private TLS pair'])
    assert.ok(runner.includes(name),'native credential fixture must remain covered: '+name);
  assert.ok(runner.includes('result.signal || result.status !== 0'),'nonzero tests fail closed');
});


test('qualification refuses an injected shell separator from a modified package script', {skip:process.platform!=='linux'},()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rc-qualification-shell-injection-'));
  try{
    for(const dir of ['tools','test'])fs.mkdirSync(path.join(temp,dir));
    fs.copyFileSync(path.join(root,'tools/run-bounded-test-script.mjs'),
      path.join(temp,'tools/run-bounded-test-script.mjs'));
    fs.writeFileSync(path.join(temp,'package.json'),JSON.stringify({
      type:'module',
      scripts:{test:'node --test test/fixture.test.mjs; node tools/out-of-scope.mjs && node --test test/fixture.test.mjs'}
    }));
    fs.writeFileSync(path.join(temp,'test/fixture.test.mjs'),
      "import test from 'node:test'; test('safe',()=>{});\n");
    fs.writeFileSync(path.join(temp,'tools/out-of-scope.mjs'),
      "import fs from 'node:fs'; fs.writeFileSync('unsafe-executed','1');\n");
    const result=spawnSync(process.execPath,[path.join(temp,'tools/run-bounded-test-script.mjs'),
      '--script','test','--concurrency','1'],{
      cwd:temp,encoding:'utf8',timeout:10000
    });
    assert.equal(result.error,undefined,result.error?.message);
    assert.notEqual(result.status,0,'shell separators must be denied');
    assert.equal(fs.existsSync(path.join(temp,'unsafe-executed')),false,
      'unapproved command must never execute');
  }finally{
    fs.rmSync(temp,{recursive:true,force:true});
  }
});

test('qualification phase parser accepts current Node and nested scripts, rejects shell grammar',()=>{
  const pkg=JSON.parse(read('package.json'));
  for(const key of ['test','check','test:v1-01-worker-grants','test:v1-01-hybrid-oauth','check:v1-01-hybrid-oauth']){
    const bounded=key==='test'||key==='check'
      ?boundNodeTestConcurrency(pkg.scripts[key],1).command:pkg.scripts[key];
    for(const part of bounded.split(' && ')){
      const phase=parseQualificationPhase(part);
      assert.ok(phase.args||phase.nested,part);
    }
  }
  assert.deepEqual(parseQualificationPhase('node --test --test-concurrency=1 test/fixture.test.mjs'),
    {args:['--test','--test-concurrency=1','test/fixture.test.mjs']});
  for(const bad of ['node --test test/a.mjs;touch-marker',
    'node --test test/a.mjs | node tools/b.mjs',
    'node --test ../other/a.mjs',
    'node --test test/a.mjs && node test/b.mjs',
    'node --check test/a.mjs test/b.mjs',
    'npm run arbitrary',
    'node -e process.exit(0)'])
    assert.throws(()=>parseQualificationPhase(bad),/CI_QUALIFICATION/);
});

test('qualification recursively runs only approved nested scripts and rejects injected nested commands',
  {skip:process.platform!=='linux'},()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rc-qualification-nested-'));
  try{
    for(const dir of ['tools','test','src'])fs.mkdirSync(path.join(temp,dir));
    fs.copyFileSync(path.join(root,'tools/run-bounded-test-script.mjs'),
      path.join(temp,'tools/run-bounded-test-script.mjs'));
    fs.writeFileSync(path.join(temp,'src/fixture.mjs'),'export const value=1;\n');
    fs.writeFileSync(path.join(temp,'test/fixture.test.mjs'),
      "import test from 'node:test'; test('safe',()=>{});\n");
    fs.writeFileSync(path.join(temp,'tools/out-of-scope.mjs'),
      "import fs from 'node:fs'; fs.writeFileSync('unsafe-executed','1');\n");
    const pkg={type:'module',scripts:{
      test:'npm run check:v1-01-hybrid-oauth && node --test test/fixture.test.mjs',
      'check:v1-01-hybrid-oauth':'node --check src/fixture.mjs'
    }};
    const run=()=>{
      fs.writeFileSync(path.join(temp,'package.json'),JSON.stringify(pkg));
      return spawnSync(process.execPath,[path.join(temp,'tools/run-bounded-test-script.mjs'),
        '--script','test','--concurrency','1'],{
        cwd:temp,encoding:'utf8',timeout:10000
      });
    };
    const ok=run();
    assert.equal(ok.status,0,ok.stderr||ok.stdout);
    pkg.scripts['check:v1-01-hybrid-oauth']=
      'node --check src/fixture.mjs; node tools/out-of-scope.mjs';
    const blocked=run();
    assert.notEqual(blocked.status,0,'injected nested commands must be rejected');
    assert.equal(fs.existsSync(path.join(temp,'unsafe-executed')),false);
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});

test('Linux qualification preserves a pinned user-local Node PATH instead of launching a login shell',{
  skip:process.platform!=='linux'
},()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rc-v012-qualification-path-'));
  try{
    for(const dir of ['tools','test','bin'])fs.mkdirSync(path.join(temp,dir));
    fs.copyFileSync(path.join(root,'tools/run-bounded-test-script.mjs'),
      path.join(temp,'tools/run-bounded-test-script.mjs'));
    fs.writeFileSync(path.join(temp,'package.json'),JSON.stringify({
      type:'module',scripts:{
        test:'node --test test/fixture-a.test.mjs && node --test test/fixture-b.test.mjs'
      }
    }));
    for(const name of ['fixture-a','fixture-b']){
      fs.writeFileSync(path.join(temp,'test',name+'.test.mjs'),
        "import test from 'node:test';\ntest('fixture',()=>{});\n");
    }
    const marker=path.join(temp,'node-invocations');
    const shim=path.join(temp,'bin','node');
    fs.writeFileSync(shim,[
      '#!/bin/sh',
      'printf x >> "$RC_PATCHED_NODE_MARKER"',
      'exec "$RC_REAL_NODE" "$@"',
      ''
    ].join('\n'),{mode:0o755});
    const out=spawnSync(process.execPath,[
      path.join(temp,'tools','run-bounded-test-script.mjs'),
      '--script','test','--concurrency','1'
    ],{
      cwd:temp,encoding:'utf8',timeout:20000,
      env:{...process.env,
        PATH:path.join(temp,'bin')+path.delimiter+(process.env.PATH??''),
        RC_PATCHED_NODE_MARKER:marker,RC_REAL_NODE:process.execPath}
    });
    assert.equal(out.error,undefined,out.error?.message);
    assert.equal(out.status,0,(out.stderr??'')+' '+(out.stdout??''));
    assert.equal(fs.readFileSync(marker,'utf8'),'xx',
      'both qualification phases must invoke the inherited explicit Node');
  }finally{
    fs.rmSync(temp,{recursive:true,force:true});
  }
});
