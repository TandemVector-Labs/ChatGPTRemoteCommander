import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCommandPlanner } from '../src/project-planner.mjs';

const FIXTURE = `
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const mode = process.argv[2];
let text='';
for await (const chunk of process.stdin) text += chunk;
const proposal = {action:'call',tool:'read_text',argumentsJson:'{"path":"proof.txt"}',summary:'Inspect evidence'};
const flag = name => process.argv[process.argv.indexOf(name)+1];
if (mode === 'echo') { proposal.summary=JSON.parse(text).marker; console.log(JSON.stringify(proposal)); }
if (mode === 'cwd') { proposal.summary=process.cwd(); console.log(JSON.stringify(proposal)); }
if (mode === 'extend' || mode === 'extend-tool') console.log(JSON.stringify({action:'extend',tool:mode==='extend'?'':'write_text',argumentsJson:JSON.stringify({steps:[{id:'inspect',title:'Inspect source'}],reason:'Missing prerequisite'}),summary:'Insert an inspection step'}));
if (mode === 'delegate' || mode === 'delegate-tool') console.log(JSON.stringify({action:'delegate',tool:mode==='delegate'?'':'write_text',argumentsJson:JSON.stringify({artifact:'draft.txt',brief:'Create one bounded draft'}),summary:'Delegate one artifact'}));
if (mode === 'bad') console.log('PRIVATE_CONTEXT not JSON');
if (mode === 'schema') console.log(JSON.stringify({...proposal, authority:true}));
if (mode === 'array') console.log(JSON.stringify({...proposal,argumentsJson:'[]'}));
if (mode === 'exit') { console.error('PRIVATE_CREDENTIAL'); process.exitCode=7; }
if (mode === 'local-ollama-error') { console.error('LOCAL_OLLAMA_HTTP_UNAVAILABLE'); process.exitCode=1; }
if (mode === 'local-ollama-timeout') { console.error('LOCAL_OLLAMA_REQUEST_TIMEOUT'); process.exitCode=1; }
if (mode === 'local-ollama-owner-key') { console.error('LOCAL_OLLAMA_OWNER_KEY_UNAVAILABLE'); process.exitCode=1; }
if (mode === 'local-ollama-secret') { console.error('LOCAL_OLLAMA_HTTP_UNAVAILABLE token=PRIVATE_CREDENTIAL'); process.exitCode=1; }
if (mode === 'local-ollama-unknown') { console.error('LOCAL_OLLAMA_UNEXPECTED'); process.exitCode=1; }
if (mode === 'stderr') { console.error('x'.repeat(10000)); setInterval(()=>{},1000); }
if (mode === 'flood') { console.log('x'.repeat(10000)); setInterval(()=>{},1000); }
if (mode === 'wait') setInterval(()=>{},1000);
if (mode === 'tree') {
  spawn(process.execPath,['-e','setTimeout(()=>require("node:fs").writeFileSync(process.argv[1],"leaked"),2500)',JSON.parse(text).marker],{stdio:'ignore'});
  setInterval(()=>{},1000);
}
`;

function fixture(t, mode, overrides = {}) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rc-planner-fixture-')));
  const script = path.join(directory, 'provider.mjs');
  fs.writeFileSync(script, FIXTURE);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const planner = createCommandPlanner({ kind: 'command', executable: process.execPath, args: [script, mode], timeoutMs: 5000, ...overrides });
  return { planner, directory };
}

test('plain command receives exact Unicode JSON context without shell interpretation', async t => {
  const { planner } = fixture(t, 'echo');
  const marker = 'سلام `literal` $(unchanged) "quoted"\nnext';
  const result = await planner.plan({ marker });
  assert.equal(result.summary, marker);
  assert.deepEqual(JSON.parse(result.argumentsJson), { path: 'proof.txt' });
});

test('provider runs outside project and owned scratch is removed on success', async t => {
  const { planner } = fixture(t, 'cwd');
  const result = await planner.plan({});
  assert.notEqual(result.summary, process.cwd());
  assert.match(path.basename(result.summary), /^rc-project-planner-/);
  assert.equal(fs.existsSync(result.summary), false);
});

test('adapter accepts a plan proposal without treating it as an executable tool', async t => {
  const {planner}=fixture(t,'extend');
  const result=await planner.plan({adaptive:{enabled:true}});
  assert.equal(result.action,'extend');assert.equal(result.tool,'');
  assert.equal(JSON.parse(result.argumentsJson).steps[0].id,'inspect');
});

test('plan proposal cannot name an executable tool', async t => {
  const {planner}=fixture(t,'extend-tool');
  await assert.rejects(planner.plan({adaptive:{enabled:true}}),{code:'PLANNER_INVALID_PROPOSAL'});
});

test('delegate remains a proposal with no executable tool attached', async t => {
  const {planner}=fixture(t,'delegate');
  const result=await planner.plan({worker:{enabled:true}});
  assert.equal(result.action,'delegate');assert.equal(result.tool,'');
  assert.deepEqual(JSON.parse(result.argumentsJson),{artifact:'draft.txt',brief:'Create one bounded draft'});
});

test('delegate proposal cannot smuggle an executable tool', async t => {
  const {planner}=fixture(t,'delegate-tool');
  await assert.rejects(planner.plan({worker:{enabled:true}}),{code:'PLANNER_INVALID_PROPOSAL'});
});

for (const [mode, code] of [
  ['bad','PLANNER_INVALID_JSON'],['schema','PLANNER_INVALID_PROPOSAL'],['array','PLANNER_INVALID_PROPOSAL'],
  ['exit','PLANNER_EXIT_FAILED'],['local-ollama-error','PLANNER_LOCAL_OLLAMA_HTTP_UNAVAILABLE'],
  ['local-ollama-timeout','PLANNER_LOCAL_OLLAMA_REQUEST_TIMEOUT'],
   ['local-ollama-owner-key','PLANNER_LOCAL_OLLAMA_OWNER_KEY_UNAVAILABLE'],
  ['local-ollama-secret','PLANNER_EXIT_FAILED'],['local-ollama-unknown','PLANNER_EXIT_FAILED'],
  ['flood','PLANNER_OUTPUT_LIMIT'],['stderr','PLANNER_OUTPUT_LIMIT']
]) {
  test('fail closed and expose only allowlisted provider diagnostics: ' + mode, async t => {
    const { planner } = fixture(t, mode, { maxOutputBytes: 4096 });
    await assert.rejects(planner.plan({}), error => error.code === code && !String(error).includes('PRIVATE'));
  });
}

test('timeout terminates a provider process tree', async t => {
  const { planner, directory } = fixture(t, 'tree', { timeoutMs: 200 });
  const marker = path.join(directory, 'child-effect.txt');
  await assert.rejects(planner.plan({ marker }), { code: 'PLANNER_TIMEOUT' });
  // Windows taskkill /T is a bounded cleanup mechanism, not a sub-second sandbox.
  // Keep the leak probe inside the 3s termination budget while allowing observed
  // taskkill latency under system load.
  await new Promise(resolve => setTimeout(resolve, 2800));
  assert.equal(fs.existsSync(marker), false);
});

test('abort stops an active provider and pre-aborted requests never start', async t => {
  const { planner } = fixture(t, 'wait');
  const controller = new AbortController();
  const pending = planner.plan({}, { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, { code: 'PLANNER_ABORTED' });
  await assert.rejects(planner.plan({}, { signal: controller.signal }), { code: 'PLANNER_ABORTED' });
});

test('missing executable fails without returning operating system details', async () => {
  const planner = createCommandPlanner({ kind: 'command', executable: path.join(os.tmpdir(), 'missing-planner-executable-93ba.exe') });
  await assert.rejects(planner.plan({}), { code: 'PLANNER_START_FAILED', message: 'PLANNER_START_FAILED' });
});

test('legacy configured provider timeout remains loadable but runtime stays transport-bounded', () => {
  const planner = createCommandPlanner({ kind: 'command', executable: process.execPath, timeoutMs: 120000 });
  assert.equal(planner.describe().timeoutMs, 30000);
});

test('provider descriptor exposes explicit hardware/model execution-profile metadata',()=>{
  const planner=createCommandPlanner({kind:'command',executable:process.execPath,
    model:'gemma4:12b',modelFamily:'gemma4',reasoningEffort:'none',
    executionMode:'project-agent',profileVersion:'2026-11'});
  const description=planner.describe();
  assert.equal(description.model,'gemma4:12b');
  assert.equal(description.modelFamily,'gemma4');
  assert.equal(description.reasoningEffort,'none');
  assert.equal(description.executionMode,'project-agent');
  assert.equal(description.profileVersion,'2026-11');
  assert.equal(description.mode,'proposal-only');
  assert.equal(JSON.stringify(description).includes(process.execPath),false);
});

test('provider rejects malformed model-profile metadata before launch',()=>{
  for(const field of ['modelFamily','reasoningEffort','executionMode','profileVersion']){
    assert.throws(()=>createCommandPlanner({kind:'command',executable:process.execPath,[field]:''}),
      error=>error?.code==='PLANNER_INVALID_CONFIG');
  }
});

test('input/configuration are bounded and command description hides argv', async t => {
  const { planner } = fixture(t, 'echo');
  assert.throws(() => createCommandPlanner({ kind: 'command', executable: 'x', timeoutMs: 0 }), /INVALID_CONFIG/);
  assert.throws(() => createCommandPlanner({ kind: 'command', executable: 'x', args: ['\0'] }), /INVALID_CONFIG/);
  await assert.rejects(planner.plan({ marker: 'x'.repeat(600000) }), { code: 'PLANNER_INPUT_LIMIT' });
  const circular = {}; circular.self = circular;
  await assert.rejects(planner.plan(circular), { code: 'PLANNER_INVALID_CONTEXT' });
  assert.equal(JSON.stringify(planner.describe()).includes('provider.mjs'), false);
});

test('Codex provider is forbidden by Commander policy before process start', () => {
  assert.throws(
    () => createCommandPlanner({ kind: 'codex', executable: 'codex.exe' }),
    error => error?.code === 'PLANNER_PROVIDER_FORBIDDEN'
  );
});

test('Claude remains unavailable until the installed client is qualified', async () => {
  const planner = createCommandPlanner({ kind: 'claude', executable: 'claude' });
  assert.equal(planner.describe().available, false);
  await assert.rejects(planner.plan({}), { code: 'PLANNER_PROVIDER_UNAVAILABLE' });
});


test('explicitly authorized Codex planner remains proposal-only', () => {
  const planner=createCommandPlanner({ kind:'codex', executable:'codex.exe', timeoutMs:30000 },{allowCodex:true});
  const description=planner.describe();
  assert.equal(description.kind,'codex');
  assert.equal(description.mode,'proposal-only');
  assert.equal(description.controls,'read-only-disabled-action-features-and-event-validation');
});


test('relative owner-approved Codex selector remains descriptive but cannot launch',async()=>{
  const planner=createCommandPlanner({kind:'codex',executable:'codex.exe',args:[]},
    {allowCodex:true});
  assert.equal(planner.describe().kind,'codex');
  await assert.rejects(planner.plan({}),{code:'PLANNER_INVALID_CONFIG'});
});
test('runtime floor matches unflagged node:sqlite availability',()=>{
  const manifest=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  assert.equal(manifest.engines?.node,'>=22.13.0');
  const [major,minor]=process.versions.node.split('.').map(Number);
  assert.ok(major>22||(major===22&&minor>=13),
    'Node 22.13+ is required for the unflagged built-in node:sqlite module');
});

test('Windows termination helpers pin taskkill to trusted machine path even if SystemRoot is forged',async()=>{
  const platform=await import('../src/platform.mjs');
  const expected=path.win32.join('C:\\Windows','System32','taskkill.exe');
  assert.equal(platform.WINDOWS_SYSTEM_TASKKILL_EXE,expected);
  const previous=process.env.SystemRoot;
  try{
    for(const forged of ['Z:\\untrusted\\windows',
      'C:\\Users\\attacker\\windows','..\\outside','']){
      process.env.SystemRoot=forged;
      assert.equal(platform.WINDOWS_SYSTEM_TASKKILL_EXE,expected);
    }
  }finally{
    if(previous===undefined)delete process.env.SystemRoot;
    else process.env.SystemRoot=previous;
  }
  const sourcePlatform=fs.readFileSync(new URL('../src/platform.mjs',import.meta.url),'utf8');
  const sourcePlanner=fs.readFileSync(new URL('../src/project-planner.mjs',import.meta.url),'utf8');
  assert.match(sourcePlatform,/spawnSync\(WINDOWS_SYSTEM_TASKKILL_EXE,/);
  assert.match(sourcePlanner,/spawn\(WINDOWS_SYSTEM_TASKKILL_EXE,/);
  assert.doesNotMatch(sourcePlatform,/path\.join\(process\.env\.SystemRoot/);
  assert.doesNotMatch(sourcePlanner,/path\.join\(process\.env\.SystemRoot/);
});

test('trusted command planner rejects relative or ambient PATH-selected executables', () => {
  for (const executable of ['node','./node','../bin/node','subdir/node','node.exe','./planner']) {
    assert.throws(() => createCommandPlanner({kind:'command',executable,args:[]}),
      /PLANNER_INVALID_CONFIG/, 'untrusted executable selector '+executable);
  }
  const planner=createCommandPlanner({kind:'command',executable:process.execPath,args:[]});
  assert.equal(planner.describe().controls,'trusted-command-process');
});
