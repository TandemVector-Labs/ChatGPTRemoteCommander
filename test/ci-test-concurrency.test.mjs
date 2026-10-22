import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseNodeQualificationPlan, markIsolatedQualificationPhases, boundNodeTestConcurrency, parseQualificationArgs, prioritizeSensitiveQualificationCommands, isolateWindowsLeaseRegression, isolateWindowsTimingSensitiveRegressions, isolateWindowsProcessTreeRegression, isolateWindowsAgentHttpRegression, isolateWindowsTransferMeshHttpRegression, isolateWindowsWorkflowPlanRegression } from '../tools/run-bounded-test-script.mjs';

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
  const files=['test/project-adaptive.test.mjs','test/project-delivery-correlation.test.mjs','test/project-engine-review.test.mjs'];
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
  command=isolateWindowsTimingSensitiveRegressions(command);
  command=isolateWindowsProcessTreeRegression(command);
  command=isolateWindowsTransferMeshHttpRegression(command);
  command=isolateWindowsLeaseRegression(command);
  const groups=command.split(' && ');
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
  assert.ok(wrapper.includes('command=markIsolatedQualificationPhases(command)'));
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
  assert.ok(fixture.includes('timeoutMs=20_000'),'same 20-second bounded readiness budget');
  assert.ok(fixture.includes('const deadline=now()+timeoutMs'),'monotonic startup deadline preserved');
  assert.ok(fixture.includes('Math.min(1500,Math.ceil(remaining))'),'each HTTP probe remains bounded');
  assert.ok(fixture.includes('if(child.exitCode!==null || child.signalCode!==null)'),'dead child fails early');
  assert.ok(fixture.includes("reason:'STARTUP_DEADLINE_EXCEEDED'"),'startup deadline fails closed');
  assert.ok(fixture.includes('assert.equal(startup.ready,true'),'server health assertion retained');
});


test('shell-free qualification plan preserves all existing Node test/check commands',()=>{
  const pkg=JSON.parse(read('package.json'));
  for(const kind of ['test','check']){
    const bounded=boundNodeTestConcurrency(pkg.scripts[kind],2).command;
    const segments=bounded.split(' && ');
    const plan=parseNodeQualificationPlan(bounded);
    assert.equal(plan.length,segments.length,kind);
    assert.ok(plan.every(step=>step.kind==='node'));
    assert.equal(plan.map(step=>'node '+step.args.join(' ')).join(' && '),bounded);
    for(const step of plan)assert.equal(step.args.some(t=>/[;&|$\x60]/.test(t)),false);
  }
  const phases=markIsolatedQualificationPhases('node --test --test-concurrency=1 test/a.test.mjs && node --check src/b.mjs');
  const plan=parseNodeQualificationPlan(phases);
  assert.deepEqual(plan.map(step=>step.kind),['marker','node','marker','marker','node','marker']);
  assert.equal(plan[0].value,'RC_QUAL_PHASE_START_00');
  assert.equal(plan[3].value,'RC_QUAL_PHASE_START_01');
});

test('shell-free qualification planner rejects injection before execution',()=>{
  for(const invalid of [
    'node --test --test-concurrency=2 test/safe.test.mjs; touch /tmp/unsafe',
    'node --test --test-concurrency=2 test/safe.test.mjs && curl https://example.invalid',
    'node --test --test-concurrency=2 test/../../tmp/unsafe.mjs',
    'node --test --test-concurrency=2 test/evil$(touch /tmp/unsafe).mjs',
    'node --test --test-concurrency=2 test/a.test.mjs | node test/b.mjs',
    'echo arbitrary',
    'node --eval process.exit(0)',
    'node --check test/a.mjs test/b.mjs',
    'node --test --test-concurrency=99 test/a.test.mjs'
  ]) assert.throws(()=>parseNodeQualificationPlan(invalid),/CI_TEST_/,invalid);
});


test('shell-free qualification planning preserves the actual Windows scheduling phases',()=>{
  const pkg=JSON.parse(read('package.json'));
  for(const kind of ['test','check']){
    let command=prioritizeSensitiveQualificationCommands(
      boundNodeTestConcurrency(pkg.scripts[kind],1).command
    );
    command=isolateWindowsAgentHttpRegression(command);
    if(kind==='test'){
      command=isolateWindowsTimingSensitiveRegressions(command);
      command=isolateWindowsProcessTreeRegression(command);
      command=isolateWindowsTransferMeshHttpRegression(command);
      command=isolateWindowsLeaseRegression(command);
      command=isolateWindowsWorkflowPlanRegression(command);
    }
    const expected=command.split(' && ');
    // R157 stamps the test path with ordered START/PASS receipts.
    const plan=parseNodeQualificationPlan(kind==='test'
      ? markIsolatedQualificationPhases(command) : command);
    const nodes=plan.filter(step=>step.kind==='node');
    assert.equal(nodes.length,expected.length,'preserve every test/check subprocess');
    assert.deepEqual(nodes.map(step=>'node '+step.args.join(' ')),expected);
    if(kind==='test'){
      const markers=plan.filter(step=>step.kind==='marker');
      assert.equal(markers.length,2*expected.length,'retain each R157 receipt');
      assert.equal(markers[0].value,'RC_QUAL_PHASE_START_00');
      assert.equal(markers.at(-1).value,
        'RC_QUAL_PHASE_PASS_'+String(expected.length-1).padStart(2,'0'));
    }
  }
});

test('Windows cold-start scheduler keeps WorkflowPlan first and adaptive immediately after',()=>{
  const code=read('tools/run-bounded-test-script.mjs');
  const start=code.indexOf("if(args.script==='test'&&process.platform==='win32'){");
  const end=code.indexOf('\n  }\n',start);
  assert.ok(start>=0&&end>start);
  const section=code.slice(start,end);
  const order=[
    'isolateWindowsProcessTreeRegression',
    'isolateWindowsTransferMeshHttpRegression',
    'isolateWindowsLeaseRegression',
    'isolateWindowsTimingSensitiveRegressions',
    'isolateWindowsWorkflowPlanRegression'
  ];
  const locations=order.map(name=>section.indexOf('command='+name+'(command);'));
  assert.ok(locations.every(i=>i>=0)&&locations.every((i,j)=>j===0||i>locations[j-1]));
  // Last prepended isolation executes first; WorkflowPlan then Adaptive are
  // therefore first. Both run exactly once, preserving all other coverage.
  assert.match(read('test/project-adaptive.test.mjs'),/\{ timeout: 6000 \}/);
});