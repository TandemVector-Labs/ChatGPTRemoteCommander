import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { powerToolDefinitions } from '../src/power-tools-v0.3.mjs';
import { synchronousCommandInput } from '../src/retry-guard.mjs';
import { browserToolDefinitions } from '../src/browser-contract.mjs';

const read = p => readFileSync(new URL('../'+p, import.meta.url), 'utf8');
const def = (defs,name) => {
  const found=defs.find(x=>x.name===name);
  assert.ok(found,`missing tool definition: ${name}`);
  return found;
};
const max = (definition,property) => definition.inputSchema?.properties?.[property]?.maximum;

test('uncertain-duration direct work is deferred or hard-bounded',()=>{
  const server=read('src/server-v0.3.mjs');
  const power=read('src/power-tools-v0.3.mjs');
  const browserProcess=read('src/browser-process.mjs');
  const guiProcess=read('src/gui-process.mjs');
  const standard=read('src/tools-v0.3.mjs');

  assert.match(server,/AUTO_DEFERRED_MUTATIONS = new Set\(\['copy_path', 'move_path', 'delete_path'\]\)/);
  assert.match(server,/asyncOperationTools\.execute\('operation_start'/);
  assert.match(server,/const \{ requestId, continuation, \.\.\.effectArgs \}/);
  assert.match(server,/tool: name,\s*arguments: effectArgs,\s*\.\.\.\(continuation \? \{ continuation \} : \{\}\)/s);
  for (const name of ['copy_path','move_path','delete_path']) {
    const d=def(powerToolDefinitions,name);
    assert.equal(d.inputSchema.properties.continuation?.type,'object');
    assert.deepEqual(d.inputSchema.properties.continuation?.required,['projectId','eventKey','root']);
  }

  // Keep the advertised schema backward-compatible with cached hosts, while the runtime hard guard remains 15 seconds.
  assert.equal(max(def(powerToolDefinitions,'run_shell'),'timeoutMs'),30000);
  assert.throws(() => synchronousCommandInput({timeoutMs:30000}), /SYNCHRONOUS_COMMAND_DEADLINE_RISK/);
  assert.equal(synchronousCommandInput({timeoutMs:10000}).timeoutMs,10000);
  assert.throws(() => synchronousCommandInput({timeoutMs:10001}), /SYNCHRONOUS_COMMAND_DEADLINE_RISK/);
  assert.equal(max(def(powerToolDefinitions,'search_files'),'maxDurationMs'),10000);
  assert.match(power,/PROCESS_LIST_TIMEOUT/);
  const startTerminalDef=def(powerToolDefinitions,'start_terminal');
  assert.equal(startTerminalDef.inputSchema.properties.interactive?.type,'boolean');
  assert.match(startTerminalDef.description,/one-shot/);
  assert.match(startTerminalDef.description,/bounded read_terminal/);
  const readTerminalDef=def(powerToolDefinitions,'read_terminal');
  assert.equal(max(readTerminalDef,'maxChars'),65536);
  assert.equal(max(readTerminalDef,'waitMs'),5000);
  assert.equal(readTerminalDef.inputSchema.properties.stdoutOffset?.minimum,0);
  assert.equal(readTerminalDef.inputSchema.properties.stderrOffset?.minimum,0);
  assert.match(power,/terminal session is one-shot and does not accept input/);
  assert.match(power,/terminateProcessTree\(session\.child\.pid/);
  assert.match(power,/setTimeout\(resolve, 1500\)/);
  assert.match(power,/setTimeout\(resolve, 500\)/);

  assert.equal(max(def(browserToolDefinitions,'browser_navigate'),'timeoutMs'),30000);
  assert.equal(max(def(browserToolDefinitions,'browser_wait'),'timeoutMs'),30000);
  assert.match(browserProcess,/timeoutMs=15000/);
  assert.match(browserProcess,/startupTimeoutMs=15000/);
  assert.match(browserProcess,/Math\.min\(35000,slowActionTimeoutMs\)/);
  assert.match(guiProcess,/timeoutMs = 15000/);
  assert.match(guiProcess,/startupTimeoutMs = 15000/);

  assert.match(standard,/Math\.min\(512 \* 1024/);
  assert.match(standard,/maxEntries \?\? 200\), 500\)/);
  assert.match(power,/maxBytes: \{ type: 'integer', minimum: 1, maximum: 262144 \}/);
});

test('CSDC-008 scope does not pretend storage stalls are solved',()=>{
  const register=read('docs/CHAT_SAFE_DURABLE_COMPLETION_REGISTER.md');
  assert.match(register,/CSDC-024[^\n]*Transient filesystem\/network-drive policy/);
});

test('turn-safe orchestration advertises bounded direct work and durable continuation',()=>{
  const server=read('src/server-v0.3.mjs');
  assert.match(server,/CHAT_STREAM_SAFE_DIRECT_CALL_BUDGET = 2/);
  assert.match(server,/rapidPollingAllowed: false/);
  assert.match(server,/longWorkMode: 'durable-background'/);
  assert.match(server,/completionBeacon: deliveryStore\.beacon\(5\)/);
  assert.match(server,/use at most \$\{CHAT_STREAM_SAFE_DIRECT_CALL_BUDGET\} direct synchronous MCP tool calls/);
  assert.match(server,/completionBeacon\.pending is nonzero/);
  assert.match(server,/Every execution turn must end with a visible closeout state/);
  assert.match(server,/operation_\* tools are not exposed by the client/);
  assert.match(server,/bounded read_terminal waitMs follow window/);
  assert.match(server,/io\.modelcontextprotocol\/tasks/);
  assert.match(server,/Persist multi-step readiness\/recovery through durable workflows/);
  assert.match(server,/keep all new reasoning and next-step decisions in the current ChatGPT conversation/);
  const skill=read('plugin-template/skills/remote-commander/SKILL.md');
  assert.match(skill,/completionBeacon\.pending > 0/);
  assert.match(skill,/Every execution turn must visibly close out/);
  assert.match(skill,/Stream cache expired/);
  assert.match(skill,/Resume stream unavailable/);
});
