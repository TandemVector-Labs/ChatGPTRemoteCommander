// Optional, outbound-only Coucou display adapter for Commander.
// No browser/cookie access, no permissions, no commands, no project text.
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomUUID as nodeRandomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const COUCOU_AGENT = 'remote-commander';

// Validate exact owner-approved local Hook bytes, rejecting symlinks and nonregular files.
// No executable is ever launched on an unverified path.
export function verifyCoucouHook(hookPath, expectedSha256) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 ?? '')) return false;
  try {
    const st = lstatSync(hookPath);
    if (!st.isFile() || st.isSymbolicLink() || st.size < 1 || st.size > 20 * 1024 * 1024) return false;
    return createHash('sha256').update(readFileSync(hookPath)).digest('hex') === expectedSha256;
  } catch { return false; }
}

const EVENTS = Object.freeze({
  workflow_create:        { event: 'SessionStart',    label: 'Workflow created' },
  workflow_run_start:     { event: 'UserPromptSubmit', label: 'Workflow started' },
  workflow_run_tick:      { event: 'PreToolUse',       label: 'Workflow step' },
  workflow_checkpoint:    { event: 'PostToolUse',      label: 'Workflow checkpoint' },
  workflow_note:          { event: 'PostToolUse',      label: 'Workflow update' },
  workflow_needs_chat:    { event: 'Notification',     label: 'Workflow needs review' },
  workflow_resume:        { event: 'UserPromptSubmit', label: 'Workflow resumed' },
  workflow_reconcile:     { event: 'PostToolUse',      label: 'Workflow reconciled' },
  workflow_finalize:      { event: 'Stop',             label: 'Workflow finalized' },
  workflow_run_resolve:   { event: 'Stop',             label: 'Workflow resolved' },
  operation_start:        { event: 'UserPromptSubmit', label: 'Commander operation queued' },
  operation_result:       { event: 'PostToolUse',      label: 'Commander operation receipt read' }
});

function safeEnvironment(env) {
  // No API keys, user-defined transport secrets, cloud credentials, or session
  // variables are inherited by the third-party subprocess.
  const allowed = [
    'PATH', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA',
    'XDG_RUNTIME_DIR', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG'
  ];
  const result = {};
  for (const name of allowed) {
    if (typeof env[name] === 'string') result[name] = env[name];
  }
  return result;
}

/**
 * Fixed safe-label mapping. Caller-provided arguments, paths, project names,
 * prompts, file contents, credentials, and tool responses are never included.
 */
export function createCoucouEvent(toolName, failed = false, sessionId = '') {
  const route = EVENTS[toolName];
  if (!route || typeof sessionId !== 'string' || !sessionId) return null;
  const kind = failed
    ? (route.event === 'Stop' ? 'StopFailure' : 'PostToolUseFailure')
    : route.event;
  return {
    hook_event_name: kind,
    coucou_agent: COUCOU_AGENT,
    session_id: sessionId,
    tool_name: route.label
  };
}

/**
 * The hook is never invoked unless owner config opts in and points to an
 * existing, absolute, OS-correct executable named exactly coucou-hook[.exe].
 *
 * Child exit code 0 is only a relay process signal, NOT proof that Coucou GUI
 * displayed the event or that a ChatGPT response was delivered.
 */
export function createCoucouBridge(config = {}, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const env = dependencies.env ?? process.env;
  const fileExists = dependencies.fileExists ?? existsSync;
  const verifyHook = dependencies.verifyHook ?? verifyCoucouHook;
  const spawn = dependencies.spawn ?? nodeSpawn;
  const randomUUID = dependencies.randomUUID ?? nodeRandomUUID;
  const enabled = config?.enabled === true;
  const nativePath = platform === 'win32' ? path.win32 : path.posix;
  const hookPath = typeof config?.hookPath === 'string' ? config.hookPath : '';
  const hookSha256 = typeof config?.hookSha256 === 'string' ? config.hookSha256.toLowerCase() : '';
  const validPath = platform === 'win32' || platform === 'linux' || platform === 'darwin';
  const expectedName = platform === 'win32' ? 'coucou-hook.exe' : 'coucou-hook';
  // A Windows local drive path is required; UNC/device namespaces could leak
  // sensitive share names through Coucou's auto-injected cwd metadata.
  const localHookPath = platform !== 'win32' || /^[A-Za-z]:[\\/]/.test(hookPath);
  const neutralCwd = nativePath.parse(hookPath).root;
  const pathIsSafe = validPath && localHookPath && hookPath.length > 0 && hookPath.length <= 1024
    && !/[\x00-\x1f]/.test(hookPath)
    && nativePath.isAbsolute(hookPath)
    && nativePath.basename(hookPath).toLowerCase() === expectedName;
  const ready = () => {
    if (!enabled || !pathIsSafe || !/^[a-f0-9]{64}$/.test(hookSha256)) return false;
    try { return fileExists(hookPath) === true && verifyHook(hookPath, hookSha256) === true; }
    catch { return false; }
  };
  const opaqueSession = randomUUID();
  let inFlight = false;
  let relayProcessExitedZero = 0;
  let dropped = 0;
  let attempted = 0;

  function emitTool(toolName, options = {}) {
    // Check the binary hash before every launch; fail closed if it changed since startup.
    if (!ready()) return false;
    const event = createCoucouEvent(toolName, options?.failed === true, opaqueSession);
    if (!event) return false;
    if (inFlight) { dropped++; return false; }
    inFlight = true;
    attempted++;
    let child;
    let timer;
    let settled = false;
    const settle = (code) => {
      if (settled) return;
      settled = true;
      inFlight = false;
      if (timer) clearTimeout(timer);
      if (code === 0) relayProcessExitedZero++;
    };
    try {
      child = spawn(hookPath, ['--agent', COUCOU_AGENT, event.hook_event_name], {
        // The official Coucou hook adds cwd to outbound event JSON even when
        // Commander omits it. Never inherit the active project/user cwd.
        cwd: neutralCwd,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'ignore'],
        env: safeEnvironment(env)
      });
      child.once('error', () => settle(-1));
      child.once('close', (code) => settle(code));
      child.stdin?.on?.('error', () => settle(-1));
      timer = setTimeout(() => {
        if (settled) return;
        try { child.kill(); } catch { /* bridge never blocks Commander */ }
        settle(-1);
      }, 750);
      timer.unref?.();
      // Coucou expects exactly one newline-terminated hook JSON record on stdin.
      child.stdin?.end?.(JSON.stringify(event) + '\n');
      return true;
    } catch {
      settle(-1);
      return false;
    }
  }

  function status() {
    return {
      enabled, ready: ready(), hookedAgent: COUCOU_AGENT,
      relayProcessExitedZero, eventsAttempted: attempted,
      eventsDropped: dropped, inFlight, guiDeliveryConfirmed: false
    };
  }

  return Object.freeze({ emitTool, status });
}
