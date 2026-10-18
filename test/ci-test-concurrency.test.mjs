import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundNodeTestConcurrency, parseQualificationArgs, prioritizeSensitiveQualificationCommands, isolateWindowsLeaseRegression, isolateWindowsTimingSensitiveRegressions, isolateWindowsProcessTreeRegression, isolateWindowsAgentHttpRegression } from '../tools/run-bounded-test-script.mjs';

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

test('R157 stage verifier derives version from the validated updater receipt and reports fail-closed stage identity',()=>{
  const workflow=read('.github/workflows/windows-updater-e2e-r157.yml');
  assert.ok(workflow.includes("$" + "report.version"),'expected stage version must come from actual updater receipt');
  assert.ok(workflow.includes("R157_STAGE_VERSION_UNVERIFIED"));
  assert.ok(workflow.includes("R157_STAGE_DIAG"),'stage probe should expose only bounded, nonsensitive counts');
  assert.ok(workflow.includes("R157_EXACT_STAGE_MISSING"));
  assert.ok(workflow.includes("R157_STAGE_GIT_HEAD_MISMATCH"));
  assert.ok(workflow.includes("git.exe -C $" + "stage rev-parse HEAD"),'staged checkout must match immutable PR commit');
  assert.ok(!workflow.includes("('releases\\v0.10.21-'+$" + "sha.Substring(0,12))"),'hardcoded release version is not authoritative');
  assert.ok(workflow.includes("R157_UNEXPECTED_ROUTE_PROMOTION"),'positive/negative NoPromote checks preserved');
});


test('R157 staged Windows receipt verifier must parse as PowerShell and retain step order',()=>{
  const workflow=read('.github/workflows/windows-updater-e2e-r157.yml');
  const marker='      - name: Independently verify exact Job receipts and no promotion';
  const next='      - name: R470 derive a bounded, allowlisted failure diagnostic';
  const first=workflow.indexOf(marker);
  const last=workflow.indexOf(next,first);
  assert.ok(first>=0 && last>first,'expected exactly ordered qualification/verifier and diagnostic steps');
  assert.equal(workflow.indexOf(marker,first+1),-1,'single stage verifier step only');
  const section=workflow.slice(first,last);
  const runHeader='        run: |';
  const runStart=section.indexOf(runHeader);
  assert.ok(runStart>=0,'verifier must contain a real run script');
  const body=section.slice(runStart+runHeader.length).replace(/^\r?\n/,'');
  const lines=body.split(/\r?\n/).filter(x=>x.length>0);
  assert.ok(lines.length>=45,'missing verifier script lines');
  assert.ok(lines.every(x=>x.startsWith('          ')),
    'all verifier script source must remain inside YAML block scalar');
  const script=lines.map(x=>x.slice(10)).join('\n');
  const sequence=[
    'R157_BAD_RESULT_','R157_PROFILE_GATE_FAIL',
    'R157_JOB_COUNT_','R157_UNEXPECTED_ROUTE_PROMOTION',
    'R157_ORPHANS_','R157_STAGE_VERSION_UNVERIFIED',
    'R157_EXACT_STAGE_MISSING','R157_STAGE_GIT_HEAD_MISMATCH',
    'R157_PASS source='
  ];
  let index=-1;
  for(const item of sequence){
    const at=script.indexOf(item,index+1);
    assert.ok(at>index,'missing or out-of-order fail-closed gate: '+item);
    index=at;
  }
  if(process.platform==='win32'){
    const verify='$tokens=$null; $errors=$null; [Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(),[ref]$tokens,[ref]$errors)|Out-Null; if(@($errors).Count){ $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }';
    const result=spawnSync('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',verify],
      {input:script,encoding:'utf8',timeout:10000});
    assert.equal(result.status,0,'PowerShell syntax invalid: '+result.stderr);
  }
});


test('R470 native dual-reporter diagnostics remain bounded, redacted, and fail closed', t=>{
  if(process.platform!=='win32') return t.skip('requires PowerShell on Windows; static checks remain cross-platform');
  const sourceSha='05bcc809b65a43c5f383bc9d1e65eb5c03151253';
  const script=path.join(root,'tools','diagnose-updater-gate-r470.ps1');
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'rc-r470-dual-reporter-'));
  const fixture=path.join(base,'expected-failure.test.mjs');
  const fixtureBody=[
    "import test from 'node:test';",
    "test('bounded public fixture failure',()=>{ throw new Error('EXPECTED_SYNTHETIC_TEST_FAILURE') });",
    ''
  ].join('\n');
  try {
    fs.writeFileSync(fixture,fixtureBody,'utf8');
    function verifyFormat(kind) {
      const dir=path.join(base,kind);
      const logDir=path.join(dir,'STATE','ChatGPTRemoteCommander','update-logs');
      fs.mkdirSync(logDir,{recursive:true});
      const name='qualification-output-qualification-test-'+sourceSha.slice(0,12)+'-fixture.stdout.log';
      const log=path.join(logDir,name);
      if(['tap','spec'].includes(kind)){
        const childEnv={...process.env};
        delete childEnv.NODE_TEST_CONTEXT; // nested test runner must not reuse parent test-worker identity
        const native=spawnSync(process.execPath,['--test','--test-reporter='+kind,fixture],
          {encoding:'utf8',timeout:15000,env:childEnv});
        assert.equal(native.status,1,'synthetic Node test must fail: '+kind);
        fs.writeFileSync(log,native.stdout,'utf8');
      } else if(kind==='unknown'){
        fs.writeFileSync(log,'NOT_A_RECOGNIZED_NODE_REPORTER\n','utf8');
      } else if(kind==='redaction'){
        fs.writeFileSync(log,'\u2716 bearer authorization private_key SENSITIVE_SENTINEL\n\u2139 fail 1\n','utf8');
      } else if(kind==='private-win-path'){
        fs.writeFileSync(log,'\u2716 failure at C:/Users/PRIVATE_ACCOUNT/Documents/confidential-data\n\u2139 fail 1\n','utf8');
      } else if(kind==='public-url'){
        fs.writeFileSync(log,'\u2716 request http://127.0.0.1:47831/router/status failed\n\u2139 fail 1\n','utf8');
      } else if(kind==='private-posix-path'){
        fs.writeFileSync(log,'not ok 1 - failure at /home/PRIVATE_ACCOUNT/confidential-data\n# fail 1\n','utf8');
      } else if(kind==='multiple'){
        fs.writeFileSync(log,'TAP version 13\n','utf8');
        fs.writeFileSync(path.join(logDir,name.replace('fixture','other')),'TAP version 13\n','utf8');
      } else {throw new Error('unexpected fixture');}
      const diagnostic=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',
        script,'-Root',dir,'-ExpectedCommit',sourceSha],{encoding:'utf8',timeout:15000});
      assert.equal(diagnostic.status,0,'sanitized diagnostic failed: '+kind+' '+diagnostic.stderr);
      const reportText=fs.readFileSync(path.join(dir,'DIAGNOSTIC_R470.json'),'utf8');
      assert.ok(!reportText.includes(base),'do not include absolute fixture paths');
      assert.ok(!reportText.includes('SENSITIVE_SENTINEL'),'do not include test-only secret sentinel');
      const report=JSON.parse(reportText);
      assert.equal(report.rawLogIncluded,false);
      assert.equal(report.secretsIncluded,false);
      return report;
    }
    const tap=verifyFormat('tap');
    assert.equal(tap.status,'TAP_SUMMARY_EXTRACTED');
    assert.equal(tap.tapCounts.fail,'1');
    assert.equal(tap.failureTests.length,1);
    const spec=verifyFormat('spec');
    assert.equal(spec.status,'SPEC_SUMMARY_EXTRACTED');
    assert.equal(spec.tapCounts.fail,'1');
    assert.equal(spec.failureTests.length,1,'spec summary must not count duplicate failure labels');
    assert.ok(spec.failureTests[0].publicTestName.includes('bounded public fixture failure'));
    const unknown=verifyFormat('unknown');
    assert.equal(unknown.status,'OUTPUT_FORMAT_UNRECOGNIZED');
    assert.equal(unknown.failureTests.length,0);
    const sensitive=verifyFormat('redaction');
    assert.equal(sensitive.status,'SPEC_SUMMARY_EXTRACTED');
    assert.equal(sensitive.failureTests[0].publicTestName,'REDACTED_TEST_NAME');
    const winPrivate=verifyFormat('private-win-path');
    assert.equal(winPrivate.status,'SPEC_SUMMARY_EXTRACTED');
    assert.equal(winPrivate.failureTests[0].publicTestName,'REDACTED_TEST_NAME');
    const publicUrl=verifyFormat('public-url');
    assert.equal(publicUrl.status,'SPEC_SUMMARY_EXTRACTED');
    assert.ok(publicUrl.failureTests[0].publicTestName.includes('http://127.0.0.1:47831/router/status'),
      'public localhost endpoint must not be mistaken for a host filesystem path');
    const posixPrivate=verifyFormat('private-posix-path');
    assert.equal(posixPrivate.status,'TAP_SUMMARY_EXTRACTED');
    assert.equal(posixPrivate.failureTests[0].publicTestName,'REDACTED_TEST_NAME');
    const ambiguous=verifyFormat('multiple');
    assert.equal(ambiguous.status,'AMBIGUOUS_MULTIPLE_MATCHING_LOGS');
    assert.equal(ambiguous.matchingLogCount,2);
    assert.equal(ambiguous.failureTests.length,0);
  } finally {
    fs.rmSync(base,{recursive:true,force:true});
  }
});
