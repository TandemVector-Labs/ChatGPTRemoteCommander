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
 * R01: isolate the three historically timing-sensitive Windows project fixtures
 * before the bulk batch. This changes scheduling only: no timeout, budget,
 * acceptance, or production state transition is modified.
 *
 * Node --test-concurrency=1 already bounds file parallelism; a separate process
 * keeps cumulative fixture side effects/host contention outside these tests.
 */
export function isolateWindowsTimingSensitiveRegressions(command) {
  if(typeof command!=='string'||!command)throw new Error('CI_WINDOWS_TIMING_COMMAND_INVALID');
  const files=['test/project-adaptive.test.mjs','test/project-delivery-correlation.test.mjs','test/project-engine-review.test.mjs'];
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

/**
 * Accept only repository-owned Node qualification commands, not arbitrary shell source.
 * R157 phase markers become bounded console output instead of shell commands.
 */
export function parseNodeQualificationPlan(command) {
  if(typeof command!=='string'||!command||command.length>20000)
    throw new Error('CI_TEST_COMMAND_INVALID');
  const parts=command.split(' && ');
  if(!parts.length||parts.some(part=>!part||part!==part.trim()))
    throw new Error('CI_TEST_COMMAND_SHAPE_INVALID');
  return parts.map(part=>{
    if(/^echo RC_QUAL_PHASE_(?:START|PASS)_[0-9]{2}$/.test(part))
      return {kind:'marker',value:part.slice('echo '.length)};
    const tokens=part.split(' ');
    if(tokens[0]!=='node'||tokens.some(x=>!x))
      throw new Error('CI_TEST_COMMAND_NOT_NODE');
    let fileStart=1;
    if(tokens[1]==='--test'){
      fileStart=2;
      if(/^--test-concurrency=[1-8]$/.test(tokens[2]??''))fileStart=3;
      else if(tokens[2]?.startsWith('--'))throw new Error('CI_TEST_OPTION_INVALID');
    }else if(tokens[1]==='--check'){
      fileStart=2;
      if(tokens.length!==3)throw new Error('CI_TEST_CHECK_CARDINALITY');
    }else if(tokens[1]?.startsWith('--'))throw new Error('CI_TEST_OPTION_INVALID');
    const files=tokens.slice(fileStart);
    const isOwnedSource=file=>{
      if(!/^(?:src|test|tools)\/[a-zA-Z0-9._/-]+\.mjs$/.test(file))return false;
      return file.split('/').every(part=>part!=='.'&&part!=='..'&&part.length>0);
    };
    if(!files.length||!files.every(isOwnedSource))
      throw new Error('CI_TEST_SOURCE_PATH_INVALID');
    return {kind:'node',args:tokens.slice(1)};
  });
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
  if(args.script==='test'&&process.platform==='win32'){
    // Compose from broad groups to single-fixture priority: the last prefix
    // executes first. Scheduler cold-start must precede resource-heavy suites.
    // Keep WorkflowPlan first, then start adaptive before the other loaded
    // crash/HTTP fixtures; retain every original test and strict deadlines.
    command=isolateWindowsProcessTreeRegression(command);
    command=isolateWindowsTransferMeshHttpRegression(command);
    command=isolateWindowsLeaseRegression(command);
    command=isolateWindowsTimingSensitiveRegressions(command);
    command=isolateWindowsWorkflowPlanRegression(command);
  }
  if(process.platform==='win32'&&args.script==='test'&&process.env.RC_QUALIFICATION_RUN_ID)
    command=markIsolatedQualificationPhases(command);
  console.log('CI_TEST_CONCURRENCY script='+args.script+' requestedConcurrency='+requestedConcurrency+' effectiveConcurrency='+effectiveConcurrency+' replacements='+bounded.replacements+' prioritizeSensitive='+prioritizeSensitive);
  // Parse all commands before starting any child. Never invoke an OS shell.
  const plan=parseNodeQualificationPlan(command);
  for(const step of plan){
    if(step.kind==='marker'){console.log(step.value);continue;}
    const child=spawnSync(process.execPath,step.args,{
      cwd:root,env:process.env,stdio:'inherit',windowsHide:true,shell:false
    });
    if(child.error)throw child.error;
    if(child.signal)throw new Error('CI_TEST_SIGNAL_'+child.signal);
    if(!Number.isInteger(child.status)||child.status!==0){
      process.exitCode=Number.isInteger(child.status)?child.status:1;
      return;
    }
  }
  process.exitCode=0;

}

if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(self)){
  try{run();}catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
}
