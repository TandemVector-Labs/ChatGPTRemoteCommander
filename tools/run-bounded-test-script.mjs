import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const self=fileURLToPath(import.meta.url);
const root=path.resolve(path.dirname(self),'..');

export function boundNodeTestConcurrency(script,concurrency){
  if(typeof script!=='string'||!script)throw new Error('CI_TEST_SCRIPT_INVALID');
  const n=Number(concurrency);
  if(!Number.isSafeInteger(n)||n<1||n>8)throw new Error('CI_TEST_CONCURRENCY_INVALID');
  const marker='node --test ';
  const count=script.split(marker).length-1;
  if(count<1)throw new Error('CI_TEST_COMMAND_MISSING');
  return {
    command:script.split(marker).join(`node --test --test-concurrency=${n} `),
    replacements:count
  };
}

const SENSITIVE_QUALIFICATION_FILES=[
  'test/mcp-tasks-extension.test.mjs',
  'test/tunnel-log-rotation.test.mjs',
  'test/async-operations.test.mjs',
  'test/workflow-http.test.mjs'
];

export function prioritizeSensitiveQualificationCommands(command){
  if(typeof command!=='string'||!command)throw new Error('CI_TEST_COMMAND_INVALID');
  const parts=command.split(' && ').map(part=>part.trim()).filter(Boolean);
  const byFile=new Map(),rest=[];
  for(const part of parts){
    const file=SENSITIVE_QUALIFICATION_FILES.find(item=>part.endsWith(' '+item));
    if(file){
      if(byFile.has(file))throw new Error('CI_TEST_SENSITIVE_COMMAND_DUPLICATE');
      byFile.set(file,part);
    }else rest.push(part);
  }
  if(byFile.size!==SENSITIVE_QUALIFICATION_FILES.length)throw new Error('CI_TEST_SENSITIVE_COMMANDS_MISSING');
  return [...SENSITIVE_QUALIFICATION_FILES.map(file=>byFile.get(file)),...rest].join(' && ');
}


// R232: keep the lease-cancellation regression as a dedicated Windows Node
// test process before the large qualification batch. No timeout is enlarged.
// A missing or duplicate test is an error, never an implicit skip.
export function isolateWindowsLeaseRegression(command){
  if(typeof command!=='string'||!command)throw new Error('CI_LEASE_TEST_COMMAND_INVALID');
  const file='test/project-engine-integration.test.mjs';
  if(command.split(file).length-1!==1)throw new Error('CI_LEASE_TEST_CARDINALITY');
  const parts=command.split(' && ');
  const index=parts.findIndex(part=>part.startsWith('node --test --test-concurrency=1 ')&&part.includes(' '+file));
  if(index<0)throw new Error('CI_LEASE_TEST_BATCH_NOT_FOUND');
  const prior=parts[index];
  const isolated=prior.replace(' '+file,'');
  if(isolated===prior||isolated.includes(file)||!isolated.startsWith('node --test --test-concurrency=1 test/'))
    throw new Error('CI_LEASE_TEST_ISOLATION_INVALID');
  parts[index]=isolated;
  return 'node --test --test-concurrency=1 '+file+' && '+parts.join(' && ');
}


/**
 * R01: isolate the four historically timing-sensitive Windows project fixtures
 * before the bulk batch. This changes scheduling only: no timeout, budget,
 * acceptance, or production state transition is modified.
 *
 * Node --test-concurrency=1 already bounds file parallelism; a separate process
 * keeps cumulative fixture side effects/host contention outside these tests.
 */
export function isolateWindowsTimingSensitiveRegressions(command) {
  if(typeof command!=='string'||!command)throw new Error('CI_WINDOWS_TIMING_COMMAND_INVALID');
  const files=['test/project-adaptive.test.mjs','test/project-delivery-correlation.test.mjs','test/project-engine-review.test.mjs','test/project-engine.test.mjs'];
  for(const file of files)
    if(command.split(file).length-1!==1)throw new Error('CI_WINDOWS_TIMING_CARDINALITY');
  const parts=command.split(' && ');
  const isolated=[];
  for(const file of files) {
    const index=parts.findIndex(part=>part.startsWith('node --test --test-concurrency=1 ')&&part.includes(' '+file));
    if(index<0)throw new Error('CI_WINDOWS_TIMING_BATCH_NOT_FOUND');
    const before=parts[index],after=before.replace(' '+file,'');
    if(after===before||!after.startsWith('node --test --test-concurrency=1 test/')||after.includes(file))
      throw new Error('CI_WINDOWS_TIMING_ISOLATION_INVALID');
    parts[index]=after;
    isolated.push('node --test --test-concurrency=1 '+file);
  }
  return [...isolated,...parts].join(' && ');
}

/**
 * R492: keep the Windows process-tree ownership/stop regression in a dedicated
 * test process. Historical loaded-host qualification timed out on stop_terminal
 * after the bulk batch had accumulated other child process fixtures. Isolating
 * this test changes scheduling ONLY: no deadline is enlarged and no test is
 * skipped or re-executed. A missing/duplicate test remains fail-closed.
 */
export function isolateWindowsProcessTreeRegression(command) {
  if(typeof command!=='string'||!command)throw new Error('CI_PROCESS_TREE_COMMAND_INVALID');
  const file='test/process-tree-lifecycle.test.mjs';
  if(command.split(file).length-1!==1)throw new Error('CI_PROCESS_TREE_CARDINALITY');
  const parts=command.split(' && ');
  const index=parts.findIndex(part=>part.startsWith('node --test --test-concurrency=1 ')&&part.includes(' '+file));
  if(index<0)throw new Error('CI_PROCESS_TREE_BATCH_NOT_FOUND');
  const original=parts[index],after=original.replace(' '+file,'');
  if(after===original||after.includes(file)||!after.startsWith('node --test --test-concurrency=1 test/'))
    throw new Error('CI_PROCESS_TREE_ISOLATION_INVALID');
  parts[index]=after;
  return 'node --test --test-concurrency=1 '+file+' && '+parts.join(' && ');
}

/**
 * R500: Windows loaded-host native CI occasionally cannot start the isolated
 * Agent Extension HTTP fixture within the existing readiness budget. Keep its
 * original deadline and exact test body, but execute the file once in its own
 * process before the high-volume suite; no skipped, duplicated, or widened
 * tests. Missing/ambiguous coverage fails closed.
 */
export function isolateWindowsAgentHttpRegression(command) {
  if(typeof command!=='string'||!command)throw new Error('CI_AGENT_HTTP_COMMAND_INVALID');
  const file='test/agent-extensions-http.test.mjs';
  if(command.split(file).length-1!==1)throw new Error('CI_AGENT_HTTP_CARDINALITY');
  const parts=command.split(' && ');
  const index=parts.findIndex(part=>part.startsWith('node --test --test-concurrency=1 ')&&part.includes(' '+file));
  if(index<0)throw new Error('CI_AGENT_HTTP_BATCH_NOT_FOUND');
  const original=parts[index],after=original.replace(' '+file,'');
  if(after===original||after.includes(file)||!after.startsWith('node --test --test-concurrency=1 test/'))
    throw new Error('CI_AGENT_HTTP_ISOLATION_INVALID');
  parts[index]=after;
  return 'node --test --test-concurrency=1 '+file+' && '+parts.join(' && ');
}

/**
 * CI Windows: preserve the exact 200x25ms readiness checks of the Transfer
 * Mesh HTTP server while giving this owned loopback fixture one standalone
 * test process before high-volume test batches. No deadlines, tool scopes,
 * assertions or native transfer behavior are changed.
 */
export function isolateWindowsTransferMeshHttpRegression(command) {
  if(typeof command!=='string'||!command)throw new Error('CI_TRANSFER_HTTP_COMMAND_INVALID');
  const file='test/transfer-mesh-http.test.mjs';
  if(command.split(file).length-1!==1)throw new Error('CI_TRANSFER_HTTP_CARDINALITY');
  const parts=command.split(' && ');
  const index=parts.findIndex(part=>part.startsWith('node --test --test-concurrency=1 ')&&part.includes(' '+file));
  if(index<0)throw new Error('CI_TRANSFER_HTTP_BATCH_NOT_FOUND');
  const original=parts[index],after=original.replace(' '+file,'');
  if(after===original||after.includes(file)||!after.startsWith('node --test --test-concurrency=1 test/'))
    throw new Error('CI_TRANSFER_HTTP_ISOLATION_INVALID');
  parts[index]=after;
  return 'node --test --test-concurrency=1 '+file+' && '+parts.join(' && ');
}

/**
 * Keep unchanged Windows browser-owned-process, workflow HTTP and transport correlation startup
 * fixtures in dedicated early test processes. Both have failed only under
 * loaded full-host qualification and passed unchanged when run in isolation.
 * Preserve exact assertions, timeouts, and one execution of every test file.
 */
export function isolateWindowsStartupReadinessRegressions(command) {
  if(typeof command!=='string'||!command)throw new Error('CI_STARTUP_READINESS_COMMAND_INVALID');
  const files=['test/workflow-http.test.mjs','test/browser-process.test.mjs','test/transport-correlation-http.test.mjs'];
  const parts=command.split(' && ');
  const isolated=[];
  for(const file of files) {
    if(command.split(file).length-1!==1)throw new Error('CI_STARTUP_READINESS_CARDINALITY');
    const index=parts.findIndex(part=>part.startsWith('node --test --test-concurrency=1 ')&&part.includes(' '+file));
    if(index<0)throw new Error('CI_STARTUP_READINESS_TEST_NOT_FOUND');
    const before=parts[index],after=before.replace(' '+file,'');
    if(before===after)throw new Error('CI_STARTUP_READINESS_ISOLATION_INVALID');
    if(after==='node --test --test-concurrency=1')parts.splice(index,1);
    else if(!after.startsWith('node --test --test-concurrency=1 test/')||after.includes(file))
      throw new Error('CI_STARTUP_READINESS_ISOLATION_INVALID');
    else parts[index]=after;
    isolated.push('node --test --test-concurrency=1 '+file);
  }
  return [...isolated,...parts].join(' && ');
}

/**
 * R157-only observation of the exact Windows qualification command chain.
 * Mark the start/pass of each original command without changing the command,
 * timeouts, test coverage or any production execution path. Only the isolated
 * updater's RC_QUALIFICATION_RUN_ID opt-in enables these public numeric markers.
 */
export function markIsolatedQualificationPhases(command) {
  if(typeof command!=='string'||!command)throw new Error('R157_PHASE_COMMAND_INVALID');
  const parts=command.split(' && ');
  if(parts.length<2||parts.length>90||parts.some(p=>!p.startsWith('node ')))
    throw new Error('R157_PHASE_COMMAND_SHAPE_INVALID');
  const marked=parts.map((part,index)=>{
    const number=String(index).padStart(2,'0');
    return 'echo RC_QUAL_PHASE_START_'+number+' && '+part+' && echo RC_QUAL_PHASE_PASS_'+number;
  }).join(' && ');
  if(marked.length>7500)throw new Error('R157_PHASE_WINDOWS_CMD_LENGTH');
  return marked;
}

/**
 * Windows qualification: run the real two-process workflow-plan SQLite race
 * tests before the loaded crash/HTTP suites. The original short contention
 * bounds and exact assertions remain unchanged; cardinality fails closed.
 */
/**
 * R157 Windows: this isolated MCP fixture starts its own server and performs
 * strict protocol/validator assertions. In loaded candidate-first updater QA
 * it once failed inside the bulk Windows batch (R470 spec summary: 478 pass,
 * 14 skipped, 1 failed) while the same exact source passed regular Windows CI.
 *
 * Schedule the unmodified test file as a standalone early process. Missing,
 * duplicate or ambiguous placement fails closed. No deadlines, assertions,
 * security policy or production behavior are changed.
 */
export function isolateWindowsMcpConformanceRegression(command) {
  if(typeof command!=='string'||!command)throw Error('CI_MCP_CONFORMANCE_COMMAND_INVALID');
  const file='test/mcp-conformance.test.mjs';
  if(command.split(file).length-1!==1)throw Error('CI_MCP_CONFORMANCE_CARDINALITY');
  const parts=command.split(' && ');
  const index=parts.findIndex(part=>part.startsWith('node --test --test-concurrency=1 ')&&part.includes(' '+file));
  if(index<0)throw Error('CI_MCP_CONFORMANCE_BATCH_NOT_FOUND');
  const original=parts[index],after=original.replace(' '+file,'');
  if(after===original||after.includes(file)||!after.startsWith('node --test --test-concurrency=1 test/'))
    throw Error('CI_MCP_CONFORMANCE_ISOLATION_INVALID');
  parts[index]=after;
  return 'node --test --test-concurrency=1 '+file+' && '+parts.join(' && ');
}

/**
 * R157: run the original native scheduler-autotick test file in its own cold
 * Windows process. Hosted NoPromote failed this exact spec in the late bulk
 * batch (R470), while the identical test passed on the Windows owner host.
 * No test, assertion, deadline or security gate is relaxed or skipped.
 */
export function isolateWindowsAutotickRegression(command) {
  if(typeof command!=='string'||!command)throw Error('CI_AUTOTICK_COMMAND_INVALID');
  const file='test/project-autotick-noncodex.test.mjs';
  if(command.split(file).length-1!==1)throw Error('CI_AUTOTICK_CARDINALITY');
  const parts=command.split(' && ');
  const index=parts.findIndex(part=>part.startsWith('node --test --test-concurrency=1 ')&&part.includes(' '+file));
  if(index<0)throw Error('CI_AUTOTICK_BATCH_NOT_FOUND');
  const before=parts[index],after=before.replace(' '+file,'');
  if(after===before||after.includes(file))throw Error('CI_AUTOTICK_ISOLATION_INVALID');
  if(after==='node --test --test-concurrency=1')parts.splice(index,1);
  else if(!after.startsWith('node --test --test-concurrency=1 test/'))
    throw Error('CI_AUTOTICK_ISOLATION_INVALID');
  else parts[index]=after;
  return 'node --test --test-concurrency=1 '+file+' && '+parts.join(' && ');
}

export function isolateWindowsWorkflowPlanRegression(command) {
  if(typeof command!=='string'||!command)throw new Error('CI_WORKFLOW_PLAN_COMMAND_INVALID');
  const file='test/workflow-plan.test.mjs';
  if(command.split(file).length-1!==1)throw new Error('CI_WORKFLOW_PLAN_CARDINALITY');
  const parts=command.split(' && ');
  const index=parts.findIndex(part=>part.startsWith('node --test --test-concurrency=1 ')&&part.includes(' '+file));
  if(index<0)throw new Error('CI_WORKFLOW_PLAN_BATCH_NOT_FOUND');
  const original=parts[index],after=original.replace(' '+file,'');
  if(after===original||after.includes(file)||!after.startsWith('node --test --test-concurrency=1 test/'))
    throw new Error('CI_WORKFLOW_PLAN_ISOLATION_INVALID');
  parts[index]=after;
  return 'node --test --test-concurrency=1 '+file+' && '+parts.join(' && ');
}

/**
 * Keep the original HTTP async-operation readiness deadline unchanged.
 * Execute this owned fixture once, in a fresh standalone Node test process,
 * before the high-volume Windows CI/Updater batch. Fail on missing/duplicate
 * fixture; never skip an acceptance assertion or enable production input.
 */
export function isolateWindowsAsyncHttpRegression(command) {
  if(typeof command!=='string'||!command)throw new Error('CI_ASYNC_HTTP_COMMAND_INVALID');
  const file='test/async-http.test.mjs';
  if(command.split(file).length-1!==1)throw new Error('CI_ASYNC_HTTP_CARDINALITY');
  const parts=command.split(' && ');
  const index=parts.findIndex(part=>part.startsWith('node --test --test-concurrency=1 ')&&part.includes(' '+file));
  if(index<0)throw new Error('CI_ASYNC_HTTP_BATCH_NOT_FOUND');
  const before=parts[index],after=before.replace(' '+file,'');
  if(after===before||after.includes(file)||!after.startsWith('node --test --test-concurrency=1 test/'))
    throw new Error('CI_ASYNC_HTTP_ISOLATION_INVALID');
  parts[index]=after;
  return 'node --test --test-concurrency=1 '+file+' && '+parts.join(' && ');
}

/**
 * Hosted Windows: the strict 6-second team-reservation regression must run
 * before the long check/test process fixture sequence in the test phase.
 * The file has already been isolated by isolateWindowsTimingSensitiveRegressions.
 * Move that exact standalone command only; retain all tests, assertions,
 * timeout budgets, other group order and fail-closed cardinality.
 */
export function prioritizeWindowsAdaptiveCold(command) {
  if (typeof command !== 'string' || !command) throw new Error('CI_COLD_ADAPTIVE_COMMAND_INVALID');
  const parts=command.split(' && ');
  const exact='node --test --test-concurrency=1 test/project-adaptive.test.mjs';
  if (parts.filter(part=>part.includes('test/project-adaptive.test.mjs')).length!==1)
    throw new Error('CI_COLD_ADAPTIVE_CARDINALITY');
  const index=parts.indexOf(exact);
  if (index<0)throw new Error('CI_COLD_ADAPTIVE_NOT_ISOLATED');
  parts.splice(index,1);
  return [exact,...parts].join(' && ');
}

/**
 * R157: an inline cmd.exe command has a small Windows length limit. Splitting
 * only at the source-controlled && boundaries preserves strict order, exact
 * test invocations and fail-fast behavior while allowing indexed receipts.
 * Each command is independently bounded before being passed to cmd.exe.
 */
export function splitWindowsQualificationCommands(command) {
  if(typeof command!=='string'||!command)throw new Error('R157_PHASE_COMMAND_INVALID');
  const parts=command.split(' && ');
  if(parts.length<2||parts.length>90||parts.some(part=>
    !part.startsWith('node ')||part.includes('\n')||part.includes('\r')||part.length>7000))
    throw new Error('R157_PHASE_COMMAND_SHAPE_INVALID');
  return parts;
}

export function parseQualificationArgs(argv){
  const out={script:null,concurrency:null,prioritizeSensitive:false};
  for(let i=0;i<argv.length;i++){
    const key=argv[i],value=argv[++i];
    if(value===undefined)throw new Error('CI_TEST_ARGUMENT_MISSING');
    if(key==='--script')out.script=value;
    else if(key==='--concurrency')out.concurrency=value;
    else if(key==='--prioritize-sensitive')out.prioritizeSensitive=value==='1'||value==='true';
    else throw new Error('CI_TEST_ARGUMENT_UNKNOWN');
  }
  if(!['test','check'].includes(out.script))throw new Error('CI_TEST_SCRIPT_NOT_ALLOWED');
  return out;
}

function run(){
  const args=parseQualificationArgs(process.argv.slice(2));
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  const original=pkg?.scripts?.[args.script];
  const requestedConcurrency=Number(args.concurrency);
  const effectiveConcurrency=process.platform==='win32'?1:requestedConcurrency;
  const bounded=boundNodeTestConcurrency(original,effectiveConcurrency);
  const prioritizeSensitive=args.prioritizeSensitive||process.platform==='win32';
  let command=prioritizeSensitive?prioritizeSensitiveQualificationCommands(bounded.command):bounded.command;
  if(process.platform==='win32') command=isolateWindowsAgentHttpRegression(command);
  // Check-gate HTTP startup tests require cold standalone Windows processes.
  // Preserve exact invocation, timeouts, cardinality and fail-fast behavior.
  if(process.platform==='win32'&&args.script==='check')
    command=isolateWindowsStartupReadinessRegressions(command);
  if(args.script==='test'&&process.platform==='win32'){
    command=isolateWindowsProcessTreeRegression(command);
    command=isolateWindowsTransferMeshHttpRegression(command);
    command=isolateWindowsLeaseRegression(command);
  }
  if(process.platform==='win32') command=isolateWindowsAsyncHttpRegression(command);
  if(args.script==='test'&&process.platform==='win32'){
    // This original strict 6s SQLite/team regression must execute in a cold
    // isolated process before other process-heavy Windows fixture groups.
    // Keep timeout, test body, full coverage and cardinality unchanged.
    command=isolateWindowsTimingSensitiveRegressions(command);
    // Short-deadline workflow-plan first, then team reservation, then async HTTP.
    command=isolateWindowsWorkflowPlanRegression(command);
    command=isolateWindowsMcpConformanceRegression(command);
    command=isolateWindowsStartupReadinessRegressions(command);
    command=prioritizeWindowsAdaptiveCold(command);
    command=isolateWindowsAutotickRegression(command);
  }
  const phases=process.platform==='win32'&&args.script==='test'&&process.env.RC_QUALIFICATION_RUN_ID
    ?splitWindowsQualificationCommands(command):null;
  console.log('CI_TEST_CONCURRENCY script='+args.script+' requestedConcurrency='+requestedConcurrency+' effectiveConcurrency='+effectiveConcurrency+' replacements='+bounded.replacements+' prioritizeSensitive='+prioritizeSensitive);
  if(phases){
    for(const [index,part] of phases.entries()){
      const marker=String(index).padStart(2,'0');
      console.log('RC_QUAL_PHASE_START_'+marker);
      const phase=spawnSync(process.env.ComSpec||'cmd.exe',['/d','/s','/c',part],{cwd:root,env:process.env,stdio:'inherit'});
      if(phase.error)throw phase.error;
      if(phase.signal)throw new Error('CI_TEST_SIGNAL_'+phase.signal);
      if(phase.status!==0){process.exitCode=Number.isInteger(phase.status)?phase.status:1;return;}
      console.log('RC_QUAL_PHASE_PASS_'+marker);
    }
    return;
  }
  const child=process.platform==='win32'
    ? spawnSync(process.env.ComSpec||'cmd.exe',['/d','/s','/c',command],{cwd:root,env:process.env,stdio:'inherit'})
    : spawnSync('/bin/sh',['-lc',command],{cwd:root,env:process.env,stdio:'inherit'});
  if(child.error)throw child.error;
  if(child.signal)throw new Error(`CI_TEST_SIGNAL_${child.signal}`);
  process.exitCode=Number.isInteger(child.status)?child.status:1;
}

if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(self)){
  try{run();}catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
}
