import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runShell, startTerminal, readTerminal, sendTerminal, stopTerminal } from '../src/power-tools-v0.3.mjs';
import { withFullPowerAccess } from './helpers/access-mode-fixtures.mjs';
import { runProjectCommand } from '../src/tools-v0.3.mjs';
import { processContainmentAvailable } from '../src/process-containment.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = (target) => fs.existsSync(target);
const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const shQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

async function fixture(t) {
  const root = fs.realpathSync.native(await mkdtemp(path.join(os.tmpdir(), 'rc-process-tree-')));
  t.after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });
  return root;
}

function powerContext(root) {
  return withFullPowerAccess({
    roots: [root],
    auditLog: path.join(root, 'audit.jsonl'),
    config: {
      capabilityProfile: { tier: 'FULL_POWER', explicitlyAuthorized: true, disabledCapabilities: [] },
      powerMode: {
        enabled: true,
        fullFilesystem: true,
        allowShell: true,
        allowProcessControl: true,
        allowPermanentDelete: true,
        maxCommandMs: 5000,
        maxOutputBytes: 262144,
        maxTerminalBufferBytes: 262144,
        blockedShellPatterns: []
      }
    }
  });
}

function delayedShellMarker(marker, started = null) {
  if (process.platform === 'win32') {
    const child = `Start-Sleep -Milliseconds 1800; Set-Content -LiteralPath ${psQuote(marker)} -Value leaked -Encoding ascii`;
    const encoded = Buffer.from(child, 'utf16le').toString('base64');
    const ready = started ? `; Set-Content -LiteralPath ${psQuote(started)} -Value started -Encoding ascii` : '';
    return `Start-Process -FilePath 'pwsh.exe' -ArgumentList '-NoLogo','-NoProfile','-EncodedCommand','${encoded}' -WindowStyle Hidden | Out-Null${ready}; Start-Sleep -Seconds 5`;
  }
  const ready = started ? `printf started > ${shQuote(started)}; ` : '';
  return `(sleep 1.8; printf leaked > ${shQuote(marker)}) & ${ready}sleep 5`;
}

async function waitForFile(target, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exists(target)) return true;
    await wait(25);
  }
  return exists(target);
}

async function readTerminalUntil(ctx, id, pattern, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let stdout = '';
  let stderr = '';
  let state = null;
  while (Date.now() < deadline) {
    const waitMs = Math.min(1000, Math.max(1, deadline - Date.now()));
    state = await readTerminal(ctx, { id, waitMs, maxChars: 4096 });
    stdout += state.stdout;
    stderr += state.stderr;
    if (pattern.test(stdout)) return { ...state, stdout, stderr };
    if (!state.running) break;
  }
  return { ...(state ?? await readTerminal(ctx, { id, maxChars: 4096 })), stdout, stderr };
}

test('run_shell timeout terminates the owned descendant process tree', { timeout: 10000 }, async (t) => {
  const root = await fixture(t);
  const marker = path.join(root, 'run-shell-leak.txt');
  const result = await runShell(powerContext(root), {
    command: delayedShellMarker(marker),
    cwd: root,
    timeoutMs: 1000
  });
  assert.equal(result.timedOut, true);
  await wait(2200);
  assert.equal(exists(marker), false);
});

test('stop_terminal terminates descendants and does not leave a delayed mutation', { timeout: 25000 }, async (t) => {
  const root = await fixture(t);
  const marker = path.join(root, 'terminal-leak.txt');
  const started = path.join(root, 'terminal-started.txt');
  const ctx = powerContext(root);
  const session = await startTerminal(ctx, {
    cwd: root,
    command: delayedShellMarker(marker, started)
  });
  assert.equal(await waitForFile(started, 8000), true);
  await stopTerminal(ctx, { id: session.id, remove: false });
  await wait(2200);
  assert.equal(exists(marker), false);
  await stopTerminal(ctx, { id: session.id, remove: true });
});

test('run_project_command timeout terminates the owned descendant process tree', { timeout: 15000 }, async (t) => {
  const root = await fixture(t);
  const marker = path.join(root, 'project-command-leak.txt');
  const parent = path.join(root, 'parent.mjs');
  const descendant = path.join(root, 'descendant.mjs');
  await writeFile(descendant, `import fs from 'node:fs'; setTimeout(()=>fs.writeFileSync(process.argv[2],'leaked'),5000); setInterval(()=>{},1000);\n`);
  await writeFile(parent, `import { spawn } from 'node:child_process'; spawn(process.execPath,[process.argv[2],process.argv[3]],{stdio:'ignore'}); setInterval(()=>{},1000);\n`);
  const ctx = {
    roots: [root],
    auditLog: path.join(root, 'standard-audit.jsonl'),
    config: { allowedPrograms: ['node'], maxCommandMs: 5000, powerMode: { enabled: false } }
  };
  const result = await runProjectCommand(ctx, {
    program: 'node',
    args: [parent, descendant, marker],
    cwd: root,
    timeoutMs: 1000
  });
  assert.equal(result.timedOut, true);
  await wait(5500);
  assert.equal(exists(marker), false);
});


test('start_terminal command defaults to one-shot and exits without leaving a prompt shell', { timeout: 10000 }, async (t) => {
  const root = await fixture(t);
  const ctx = powerContext(root);
  const command = process.platform === 'win32' ? "Write-Output 'ONE_SHOT_DONE'" : "printf 'ONE_SHOT_DONE\\n'";
  const session = await startTerminal(ctx, { cwd: root, command });
  assert.equal(session.interactive, false);
  assert.equal(session.autoClose, true);
  for (let i=0;i<120;i++) {
    const state = await readTerminal(ctx, { id: session.id, consume: false });
    if (!state.running) {
      assert.match(state.stdout,/ONE_SHOT_DONE/);
      assert.equal(state.interactive,false);
      assert.equal(state.autoClose,true);
      await assert.rejects(sendTerminal(ctx,{id:session.id,input:'x'}),/one-shot/);
      await stopTerminal(ctx,{id:session.id,remove:true});
      return;
    }
    await wait(25);
  }
  assert.fail('one-shot terminal did not exit');
});

test('read_terminal pages large output without skipping unread data', { timeout: 10000 }, async (t) => {
  const root = await fixture(t);
  const ctx = powerContext(root);
  const command = process.platform === 'win32'
    ? "[Console]::Out.Write((('A' * 90000) -join ''))"
    : "yes A | tr -d '\\n' | head -c 90000";
  const session = await startTerminal(ctx, { cwd: root, command });
  for (let i=0;i<120;i++) {
    const state = await readTerminal(ctx, { id: session.id, consume: false, maxChars: 32768 });
    if (!state.running) break;
    await wait(25);
  }
  const first = await readTerminal(ctx, { id: session.id, maxChars: 32768 });
  assert.equal(first.stdout.length, 32768);
  assert.equal(first.stdoutOffset, 0);
  assert.equal(first.nextStdoutOffset, 32768);
  assert.equal(first.stdoutRemainingChars, 90000 - 32768);
  const second = await readTerminal(ctx, { id: session.id, maxChars: 32768 });
  assert.equal(second.stdout.length, 32768);
  assert.equal(second.stdoutOffset, 32768);
  assert.equal(second.nextStdoutOffset, 65536);
  const tail = await readTerminal(ctx, { id: session.id, stdoutOffset: second.nextStdoutOffset, maxChars: 65536, consume: false });
  assert.equal(tail.stdout.length, 90000 - 65536);
  assert.equal(tail.nextStdoutOffset, null);
  await stopTerminal(ctx,{id:session.id,remove:true});
});

test('read_terminal bounded wait returns when new output arrives', { timeout: 15000 }, async (t) => {
  const root = await fixture(t);
  const ctx = powerContext(root);
  const ready = path.join(root, 'terminal-read-ready.txt');
  const command = process.platform === 'win32'
    ? `Set-Content -LiteralPath ${psQuote(ready)} -Value ready -Encoding ascii; Start-Sleep -Milliseconds 500; Write-Output 'DELAYED_OUTPUT'`
    : `printf ready > ${shQuote(ready)}; sleep 0.5; printf 'DELAYED_OUTPUT\\n'`;
  const session = await startTerminal(ctx, { cwd: root, command });
  assert.equal(await waitForFile(ready, 5000), true);
  const started = Date.now();
  const state = await readTerminalUntil(ctx,session.id,/DELAYED_OUTPUT/,5000);
  assert.match(state.stdout,/DELAYED_OUTPUT/);
  assert.ok(Date.now() - started < 5000);
  await stopTerminal(ctx,{id:session.id,remove:true});
});
test('start_terminal remains interactive only when explicitly requested with an initial command', { timeout: 40000 }, async (t) => {
  const root = await fixture(t);
  const ctx = powerContext(root);
  const command = process.platform === 'win32' ? "Write-Output 'INTERACTIVE_READY'" : "printf 'INTERACTIVE_READY\\n'";
  const session = await startTerminal(ctx, { cwd: root, command, interactive: true });
  assert.equal(session.interactive,true);
  assert.equal(session.autoClose,false);
  try {
    const state=await readTerminalUntil(ctx,session.id,/INTERACTIVE_READY/,15000);
    assert.match(state.stdout,/INTERACTIVE_READY/,'interactive terminal did not accept initial command within bounded readiness wait');
    assert.equal(state.running,true);
    const followup = process.platform === 'win32' ? "Write-Output 'INTERACTIVE_FOLLOWUP'" : "printf 'INTERACTIVE_FOLLOWUP\\n'";
    await sendTerminal(ctx,{id:session.id,input:followup});
    const next=await readTerminalUntil(ctx,session.id,/INTERACTIVE_FOLLOWUP/,15000);
    assert.match(next.stdout,/INTERACTIVE_FOLLOWUP/,'interactive terminal did not accept follow-up input');
    assert.equal(next.running,true);
  } finally {
    await stopTerminal(ctx,{id:session.id,remove:true}).catch(()=>{});
  }
});


function workflowBinding(stepId) {
  return {
    workflowId:'process-tree-lifecycle',
    stepId,
    operationId:randomUUID(),
    rootFingerprint:'a'.repeat(64),
    revision:1,
    leaseId:'b'.repeat(64),
    fencingToken:1
  };
}

test('workflow-bound run_project_command uses the cessation-proof provider', { timeout: 15000 }, async t => {
  const root=await fixture(t);
  const ctx={
    roots:[root],
    auditLog:path.join(root,'workflow-project-audit.jsonl'),
    config:{allowedPrograms:['node'],maxCommandMs:5000,powerMode:{enabled:false}},
    workflowOperation:workflowBinding('project-command')
  };
  const script=path.join(root,'workflow-command.mjs');
  await writeFile(script,"process.stdout.write('WORKFLOW_PROJECT_COMMAND_OK')\n");
  if(!(await processContainmentAvailable())){
    await assert.rejects(runProjectCommand(ctx,{
      program:'node',args:[script],cwd:root,timeoutMs:5000
    }),/PROCESS_CONTAINMENT_UNAVAILABLE/);
    return t.skip('native containment unavailable; fail-closed refusal verified');
  }
  const result=await runProjectCommand(ctx,{
    program:'node',args:[script],
    cwd:root,timeoutMs:5000
  });
  assert.equal(result.exitCode,0);
  assert.equal(result.isError,false);
  assert.equal(result.containment.verified,true);
  assert.equal(result.processCessationProof.workflowId,'process-tree-lifecycle');
  assert.equal(result.processCessationProof.stepId,'project-command');
  assert.equal(result.processCessationProof.operationId,ctx.workflowOperation.operationId);
  assert.equal(result.processCessationProof.fencingToken,ctx.workflowOperation.fencingToken);
  assert.match(result.stdout,/WORKFLOW_PROJECT_COMMAND_OK/);
});

test('workflow-bound run_shell uses the cessation-proof provider', { timeout: 15000 }, async t => {
  const root=await fixture(t);
  const ctx=powerContext(root);
  ctx.workflowOperation=workflowBinding('shell');
  const command=process.platform==='win32'?"Write-Output 'WORKFLOW_SHELL_OK'":"printf 'WORKFLOW_SHELL_OK\n'";
  if(!(await processContainmentAvailable())){
    await assert.rejects(runShell(ctx,{command,cwd:root,timeoutMs:5000}),
      /PROCESS_CONTAINMENT_UNAVAILABLE/);
    return t.skip('native containment unavailable; fail-closed refusal verified');
  }
  const result=await runShell(ctx,{command,cwd:root,timeoutMs:5000});
  assert.equal(result.exitCode,0);
  assert.equal(result.isError,false);
  assert.equal(result.containment.verified,true);
  assert.equal(result.processCessationProof.workflowId,'process-tree-lifecycle');
  assert.equal(result.processCessationProof.stepId,'shell');
  assert.equal(result.processCessationProof.operationId,ctx.workflowOperation.operationId);
  assert.equal(result.processCessationProof.fencingToken,ctx.workflowOperation.fencingToken);
  assert.match(result.stdout,/WORKFLOW_SHELL_OK/);
});
