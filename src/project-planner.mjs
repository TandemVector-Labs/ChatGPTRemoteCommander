import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, open, lstat, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertNoCodexDelegatingScript, assertNoCodexExecutable, commanderChildEnv } from './no-codex-policy.mjs';
import { WINDOWS_SYSTEM_TASKKILL_EXE } from './platform.mjs';

const MAX_INPUT_BYTES = 512 * 1024;
const FIELDS = ['action', 'tool', 'argumentsJson', 'summary'];
const SCHEMA = {
  type: 'object', additionalProperties: false, required: FIELDS,
  properties: {
    action: { type: 'string', enum: ['call', 'block', 'extend', 'delegate'] },
    tool: { type: 'string' }, argumentsJson: { type: 'string' }, summary: { type: 'string' }
  }
};
const DISABLED_CODEX_FEATURES = [
  'apps', 'plugins', 'hooks', 'shell_tool', 'unified_exec', 'computer_use',
  'browser_use', 'browser_use_external', 'browser_use_full_cdp_access',
  'multi_agent', 'memories', 'image_generation', 'code_mode_host',
  'skill_search', 'skill_mcp_dependency_install', 'goals', 'remote_plugin', 'tool_suggest'
];
const INSTRUCTIONS = 'Return exactly one JSON proposal matching the supplied schema. Use only the supplied context. Do not use tools, read files, run commands, edit files, or perform the action. Commander alone executes proposed actions. Choose block when evidence or authority is missing. Choose delegate only when the supplied worker context explicitly enables it. argumentsJson must encode a JSON object.\n';

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

// The local Ollama adapter emits these fixed codes on stderr. Preserve only
// an exact allowlisted code; never retain or expose arbitrary provider output.
const SAFE_LOCAL_OLLAMA_FAILURES = new Set([
  'LOCAL_OLLAMA_OWNER_KEY_UNAVAILABLE',
  'LOCAL_OLLAMA_OWNER_KEY_UNTRUSTED',
  'LOCAL_OLLAMA_OWNER_KEY_INVALID',
  'LOCAL_OLLAMA_MODEL_NOT_CONFIGURED',
  'LOCAL_OLLAMA_INPUT_TOO_LARGE',
  'LOCAL_OLLAMA_INVALID_CONFIG',
  'LOCAL_OLLAMA_HTTP_UNAVAILABLE',
  'LOCAL_OLLAMA_REQUEST_TIMEOUT',
  'LOCAL_OLLAMA_RESPONSE_TOO_LARGE',
  'LOCAL_OLLAMA_INVALID_HTTP_JSON',
  'LOCAL_OLLAMA_INVALID_CONTENT',
  'LOCAL_OLLAMA_INVALID_MODEL_JSON',
  'LOCAL_OLLAMA_INVALID_PROPOSAL',
  'LOCAL_OLLAMA_INVALID_ARGUMENTS',
  'LOCAL_OLLAMA_BLOCK_WITH_TOOL',
  'LOCAL_OLLAMA_TOOL_NOT_ADMITTED',
  'LOCAL_OLLAMA_FAILED'
]);

function safeLocalOllamaFailureCode(line) {
  const code = String(line ?? '').replace(/\r$/, '');
  return SAFE_LOCAL_OLLAMA_FAILURES.has(code) ? `PLANNER_${code}` : null;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw fail('PLANNER_INVALID_CONFIG');
  return result;
}

function parseProposal(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw fail('PLANNER_INVALID_JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== FIELDS.length
      || FIELDS.some(key => !Object.hasOwn(value, key) || typeof value[key] !== 'string')
      || !['call', 'block', 'extend', 'delegate'].includes(value.action)
      || value.tool.length > 200 || value.argumentsJson.length > 256 * 1024
      || value.summary.length > 8000
      || (value.action === 'call' && !/^[A-Za-z][A-Za-z0-9_.:-]{0,199}$/.test(value.tool))
      || (value.action !== 'call' && value.tool !== '')) {
    throw fail('PLANNER_INVALID_PROPOSAL');
  }
  let args;
  try { args = JSON.parse(value.argumentsJson); } catch { throw fail('PLANNER_INVALID_PROPOSAL'); }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('PLANNER_INVALID_PROPOSAL');
  return Object.fromEntries(FIELDS.map(key => [key, value[key]]));
}

// JSONL is audit evidence, not the structured final result. Reject any execution
// or unknown event even if the child eventually returns a valid proposal.
const CODEX_DISABLED_CODE_MODE_DIAGNOSTIC =
  'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable \`features.code_mode_host\` and install \`codex-code-mode-host\`.';

function inspectCodexEvents(text) {
  let complete = false;
  let started = false;
  let threadStarted = false;
  let benignDiagnosticSeen = false;
  for (const line of text.split(/\r?\n/).filter(line => line.trim())) {
    let event;
    try { event = JSON.parse(line); } catch { throw fail('PLANNER_INVALID_EVENTS'); }
    if (!event || typeof event !== 'object') throw fail('PLANNER_INVALID_EVENTS');
    if (event.type === 'thread.started') {
      if (threadStarted || started || complete) throw fail('PLANNER_INVALID_EVENTS');
      threadStarted = true;
    } else if (event.type === 'turn.started') {
      if (!threadStarted || started || complete) throw fail('PLANNER_INVALID_EVENTS');
      started = true;
    } else if (event.type === 'turn.completed') {
      if (!started || complete) throw fail('PLANNER_INVALID_EVENTS');
      complete = true;
    } else if (['item.started', 'item.updated', 'item.completed'].includes(event.type)) {
      const item = event.item;
      if (event.type === 'item.completed' && item?.type === 'error') {
        const keys = item && typeof item === 'object' ? Object.keys(item).sort().join(',') : '';
        if (!threadStarted || started || complete || benignDiagnosticSeen
            || keys !== 'id,message,type' || typeof item.id !== 'string'
            || item.message !== CODEX_DISABLED_CODE_MODE_DIAGNOSTIC) throw fail('PLANNER_UNEXPECTED_TOOL');
        benignDiagnosticSeen = true;
      } else if (!started || complete || !['agent_message', 'reasoning'].includes(item?.type)) {
        throw fail('PLANNER_UNEXPECTED_TOOL');
      }
    } else if (event.type === 'turn.failed' || event.type === 'error') {
      throw fail('PLANNER_PROVIDER_FAILED');
    } else {
      throw fail('PLANNER_INVALID_EVENTS');
    }
  }
  if (!complete) throw fail('PLANNER_INCOMPLETE_RESULT');
}

async function readFinalFile(finalPath, remainingBytes) {
  let stat;
  try { stat = await lstat(finalPath); } catch { throw fail('PLANNER_INCOMPLETE_RESULT'); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw fail('PLANNER_INVALID_RESULT_FILE');
  if (stat.size > remainingBytes) throw fail('PLANNER_OUTPUT_LIMIT');
  const file = await open(finalPath, 'r');
  try {
    const actual = await file.stat();
    if (!actual.isFile() || actual.nlink !== 1 || actual.dev !== stat.dev || actual.ino !== stat.ino) {
      throw fail('PLANNER_INVALID_RESULT_FILE');
    }
    // Cap the read itself, including a concurrently growing result file.
    const buffer = Buffer.alloc(remainingBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > remainingBytes) throw fail('PLANNER_OUTPUT_LIMIT');
    return buffer.subarray(0, offset).toString('utf8');
  } finally { await file.close(); }
}

function runProcess(executable, args, input, { cwd, timeoutMs, maxOutputBytes, signal, allowCodex = false }) {
  return new Promise((resolve, reject) => {
    let child, timer, killTimer, failure, done = false, bytes = 0, stderrLine = '', stderrLineComplete = false;
    const chunks = [];
    const settle = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const terminate = error => {
      if (done || failure) return;
      failure = error;
      if (!child?.pid) { settle(error); return; }
      // Kill the process tree, not just the CLI. Never invoke a shell.
      if (process.platform === 'win32') {
        const killer = spawn(WINDOWS_SYSTEM_TASKKILL_EXE,
          ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
        killer.once('error', () => { try { child.kill('SIGKILL'); } catch {} });
        killer.once('close', () => { try { child.kill('SIGKILL'); } catch {} });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
      }
      killTimer = setTimeout(() => {
        const terminationError = fail('PLANNER_TERMINATION_FAILED');
        Object.defineProperty(terminationError, 'cleanupSafe', { value: false });
        settle(terminationError);
      }, 3000);
    };
    const abort = () => terminate(fail('PLANNER_ABORTED'));
    if (signal?.aborted) { settle(fail('PLANNER_ABORTED')); return; }
    try {
      child = spawn(executable, args, {
        cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'], env: commanderChildEnv(process.cwd(), process.env, { allowCodex })
      });
    } catch { settle(fail('PLANNER_START_FAILED')); return; }
    child.once('error', () => settle(fail('PLANNER_START_FAILED')));
    child.stdin.on('error', () => terminate(fail('PLANNER_INPUT_FAILED')));
    child.stdout.on('data', chunk => {
      if (done || failure) return;
      bytes += chunk.length;
      if (bytes > maxOutputBytes) terminate(fail('PLANNER_OUTPUT_LIMIT'));
      else chunks.push(chunk);
    });
    child.stderr.on('data', chunk => {
      if (done || failure) return;
      bytes += chunk.length;
      if (bytes > maxOutputBytes) terminate(fail('PLANNER_OUTPUT_LIMIT'));
      // Retain at most one short first line in memory. It is surfaced only if
      // it exactly matches a fixed local-adapter code; all other stderr is lost.
      if (!stderrLineComplete) {
        const text = chunk.toString('utf8');
        const newline = text.indexOf('\n');
        const firstLine = newline >= 0 ? text.slice(0, newline) : text;
        const remaining = 64 - Buffer.byteLength(stderrLine, 'utf8');
        if (remaining > 0) {
          stderrLine += Buffer.from(firstLine, 'utf8').subarray(0, remaining).toString('utf8');
        }
        if (newline >= 0 || Buffer.byteLength(stderrLine, 'utf8') >= 64) stderrLineComplete = true;
      }
    });
    child.once('close', (code, exitSignal) => {
      if (failure) { settle(failure); return; }
      if (code !== 0 || exitSignal) {
        const safeCode = exitSignal ? null : safeLocalOllamaFailureCode(stderrLine);
        settle(fail(safeCode ?? 'PLANNER_EXIT_FAILED'));
        return;
      }
      settle(null, { stdout: Buffer.concat(chunks).toString('utf8'), bytes });
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    timer = setTimeout(() => terminate(fail('PLANNER_TIMEOUT')), timeoutMs);
    child.stdin.end(input, 'utf8');
  });
}

/** Trusted operator configuration only. These providers propose; the engine
 * validates policy, revisions and action arguments before dispatching anything.
 * A command provider is operator-supplied code, not an isolation boundary.
 */
export function createCommandPlanner(config, { allowCodex = false } = {}) {
  if (config?.kind === 'codex' && !allowCodex) throw fail('PLANNER_PROVIDER_FORBIDDEN');
  if (!config || !['codex', 'claude', 'command'].includes(config.kind)) throw fail('PLANNER_INVALID_CONFIG');
  const { kind, executable, model, modelFamily, reasoningEffort, executionMode, profileVersion } = config;
  const args = config.args ?? [];
  assertNoCodexExecutable(executable, { allowCodex });
  // An owner-approved command must name its exact program; a bare PATH
  // lookup (or a scratch-relative executable) can select a different binary.
  if (typeof executable !== 'string' || !executable
      || (kind === 'command' && !path.isAbsolute(executable))
      || executable.includes('\0')
      || !Array.isArray(args) || args.length > 64
      || args.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > 8192)
      || (model !== undefined && (typeof model !== 'string' || !model || model.length > 160 || /[\x00-\x1f]/.test(model)))) {
    throw fail('PLANNER_INVALID_CONFIG');
  }
  for (const [field, maximum] of Object.entries({modelFamily:128,reasoningEffort:32,executionMode:64,profileVersion:64})) {
    const value=config[field];
    if(value!==undefined&&(typeof value!=='string'||!value||value.length>maximum||/[\x00-\x1f]/.test(value))) {
      throw fail('PLANNER_INVALID_CONFIG');
    }
  }
  const launchArgs = [...args];
  const configuredTimeoutMs = boundedInteger(config.timeoutMs, 30000, 10, 600000);
  const timeoutMs = Math.min(configuredTimeoutMs, 30000);
  const maxOutputBytes = boundedInteger(config.maxOutputBytes, 2 * 1024 * 1024, 64, 16 * 1024 * 1024);
  return {
    describe() {
      const description={
        kind, model: model ?? null, timeoutMs, maxOutputBytes,
        mode: 'proposal-only', available: kind !== 'claude',
        controls: kind === 'codex' ? 'read-only-disabled-action-features-and-event-validation'
          : kind === 'command' ? 'trusted-command-process' : 'qualification-required'
      };
      if(modelFamily!==undefined)description.modelFamily=modelFamily;
      if(reasoningEffort!==undefined)description.reasoningEffort=reasoningEffort;
      if(executionMode!==undefined)description.executionMode=executionMode;
      if(profileVersion!==undefined)description.profileVersion=profileVersion;
      return description;
    },
    async plan(context, { signal } = {}) {
      if (kind === 'claude') throw fail('PLANNER_PROVIDER_UNAVAILABLE');
      // A relative Codex alias is safe to describe but never to execute.
      // Resolve only explicitly named absolute owner executables at launch.
      if (!path.isAbsolute(executable)) throw fail('PLANNER_INVALID_CONFIG');
      if (signal?.aborted) throw fail('PLANNER_ABORTED');
      let serialized;
      try { serialized = JSON.stringify(context); } catch { throw fail('PLANNER_INVALID_CONTEXT'); }
      if (!serialized) throw fail('PLANNER_INVALID_CONTEXT');
      if (Buffer.byteLength(serialized, 'utf8') > MAX_INPUT_BYTES) throw fail('PLANNER_INPUT_LIMIT');
      let scratch, scratchRoot, cleanupSafe = true;
      try {
        await assertNoCodexDelegatingScript(executable, launchArgs, process.cwd(), { allowCodex });
        scratchRoot = await realpath(os.tmpdir());
        scratch = await realpath(await mkdtemp(path.join(scratchRoot, 'rc-project-planner-')));
        let commandArgs = [...launchArgs];
        let input = serialized;
        let finalPath;
        if (kind === 'codex') {
          const schemaPath = path.join(scratch, 'proposal.schema.json');
          finalPath = path.join(scratch, 'proposal.json');
          await writeFile(schemaPath, JSON.stringify(SCHEMA), { mode: 0o600, flag: 'wx' });
          commandArgs.push('exec', '--sandbox', 'read-only', '--ephemeral', '--ignore-user-config', '--ignore-rules',
            '--skip-git-repo-check', '--color', 'never', '--json', '--output-schema', schemaPath,
            '--output-last-message', finalPath, '--cd', scratch,
            '-c', 'approval_policy="never"', '-c', 'web_search="disabled"');
          for (const feature of DISABLED_CODEX_FEATURES) commandArgs.push('--disable', feature);
          if (model) commandArgs.push('--model', model);
          commandArgs.push('-');
          input = INSTRUCTIONS + serialized;
        }
        const result = await runProcess(executable, commandArgs, input, { cwd: scratch, timeoutMs, maxOutputBytes, signal, allowCodex });
        if (signal?.aborted) throw fail('PLANNER_ABORTED');
        if (kind === 'command') return parseProposal(result.stdout);
        inspectCodexEvents(result.stdout);
        return parseProposal(await readFinalFile(finalPath, maxOutputBytes - result.bytes));
      } catch (error) {
        cleanupSafe = error?.cleanupSafe !== false;
        if (typeof error?.code === 'string' && /^PLANNER_[A-Z_]+$/.test(error.code)) throw error;
        throw fail('PLANNER_IO_FAILED');
      } finally {
        // Only remove the directory created by this call, after its process exits.
        if (scratch && cleanupSafe) {
          if (path.dirname(scratch) !== scratchRoot || !/^rc-project-planner-[A-Za-z0-9]+$/.test(path.basename(scratch))) {
            throw fail('PLANNER_CLEANUP_FAILED');
          }
          try { await rm(scratch, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }); }
          catch { throw fail('PLANNER_CLEANUP_FAILED'); }
        }
      }
    }
  };
}
