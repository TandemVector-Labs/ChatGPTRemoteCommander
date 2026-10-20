import fs from 'node:fs';
import { codexLaunchAuthorized, isCodexExecutable } from './no-codex-policy.mjs';

const RUNNER_ALLOWED_TOOLS = Object.freeze([
  'list_directory','read_text','file_info','write_text','create_directory'
]);

function clone(value) { return JSON.parse(JSON.stringify(value ?? {})); }

function executableFile(file, platform = process.platform) {
  if (typeof file !== 'string' || !file || file.includes('\0')) return false;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    if (platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function discoverQualifiedProjectProvider() {
  return {
    status: 'FORBIDDEN',
    kind: 'codex',
    version: null,
    executable: null,
    reason: 'NO_CODEX_VIA_COMMANDER'
  };
}

function disableRunner(existing, reason = 'NO_AUTOMATIC_MODEL_PROVIDER') {
  const current = existing && typeof existing === 'object' && !Array.isArray(existing) ? clone(existing) : {};
  const currentProvider = current.provider && typeof current.provider === 'object' && !Array.isArray(current.provider)
    ? clone(current.provider) : {};
  const codex = current.kind === 'codex' || currentProvider.kind === 'codex'
    || isCodexExecutable(current.executable) || isCodexExecutable(currentProvider.executable);
  return {
    ...current,
    ...(codex ? { kind: 'disabled' } : {}),
    enabled: false,
    autoTick: false,
    provider: codex
      ? { kind: 'disabled', reason: 'NO_CODEX_VIA_COMMANDER' }
      : (Object.keys(currentProvider).length ? currentProvider : { kind: 'disabled', reason })
  };
}

function normalizedExplicitRunner(existing) {
  const current = clone(existing);
  const provider = clone(current.provider);
  return {
    ...current,
    enabled: true,
    autoTick: current.autoTick !== false,
    provider: {
      ...provider,
      timeoutMs: Math.min(Number.isSafeInteger(Number(provider.timeoutMs)) ? Number(provider.timeoutMs) : 30_000, 30_000),
      maxOutputBytes: Number.isSafeInteger(Number(provider.maxOutputBytes))
        ? Math.min(Math.max(Number(provider.maxOutputBytes), 64), 16 * 1024 * 1024)
        : 2 * 1024 * 1024
    },
    allowedTools: Array.isArray(current.allowedTools) && current.allowedTools.length
      ? [...current.allowedTools] : [...RUNNER_ALLOWED_TOOLS],
    maxActions: Number.isSafeInteger(Number(current.maxActions)) ? Number(current.maxActions) : 32,
    maxDurationMs: Number.isSafeInteger(Number(current.maxDurationMs)) ? Number(current.maxDurationMs) : 300_000,
    maxPlannerCalls: Number.isSafeInteger(Number(current.maxPlannerCalls)) ? Number(current.maxPlannerCalls) : 128,
    adaptive: {
      enabled: current.adaptive?.enabled !== false,
      maxExtensions: Number.isSafeInteger(Number(current.adaptive?.maxExtensions))
        ? Number(current.adaptive.maxExtensions) : 4
    },
    // Absence of team means single-planner mode. Never silently add workers
    // during configuration migration, update, or normalization.
    ...(current.team == null ? {} : { team: current.team }),
    worker: {
      enabled: current.worker?.enabled !== false,
      maxArtifactBytes: Number.isSafeInteger(Number(current.worker?.maxArtifactBytes))
        ? Number(current.worker.maxArtifactBytes) : 65_536
    }
  };
}

export function mergeExplicitOwnerRunnerPolicy(activeConfig, canonicalConfig, { platform = process.platform } = {}) {
  const active = clone(activeConfig);
  const activeRunner = active?.durableWorkflows?.runner;
  const legacyPolicyDisabled = activeRunner?.enabled !== true
    && activeRunner?.provider?.kind === 'disabled'
    && activeRunner?.provider?.reason === 'NO_CODEX_VIA_COMMANDER';
  if (!legacyPolicyDisabled) {
    return { config: active, merged: false, status: 'ACTIVE_POLICY_PRESERVED' };
  }

  const canonical = applyProjectRunnerConfig(canonicalConfig, { platform });
  if (canonical.status !== 'PRESERVED_EXPLICIT_OWNER_CODEX_PROVIDER') {
    return { config: active, merged: false, status: 'CANONICAL_OWNER_RUNNER_NOT_AUTHORIZED' };
  }

  active.durableWorkflows ??= {};
  active.durableWorkflows.runner = clone(canonical.config.durableWorkflows.runner);
  const verified = applyProjectRunnerConfig(active, { platform });
  if (verified.status !== 'PRESERVED_EXPLICIT_OWNER_CODEX_PROVIDER') {
    return { config: clone(activeConfig), merged: false, status: 'ACTIVE_AUTHORITY_REJECTED_OWNER_RUNNER' };
  }
  return {
    config: verified.config,
    merged: true,
    status: 'RECOVERED_EXPLICIT_OWNER_CODEX_PROVIDER'
  };
}

export function applyProjectRunnerConfig(config, { platform = process.platform } = {}) {
  const next = clone(config);
  next.durableWorkflows ??= {};
  const profile = next.capabilityProfile ?? {};
  const disabled = new Set(Array.isArray(profile.disabledCapabilities) ? profile.disabledCapabilities : []);
  const authorized = profile.tier === 'FULL_POWER' && profile.explicitlyAuthorized === true;

  if (!authorized || disabled.has('workflow.project_engine') || next.durableWorkflows.enabled !== true) {
    if (next.durableWorkflows.runner && typeof next.durableWorkflows.runner === 'object') {
      next.durableWorkflows.runner = disableRunner(next.durableWorkflows.runner,
        disabled.has('workflow.project_engine') ? 'EXPLICITLY_DISABLED' : 'AUTHORITY_DISABLED');
    }
    return {
      config: next,
      status: disabled.has('workflow.project_engine') ? 'EXPLICITLY_DISABLED' : authorized ? 'WORKFLOW_DISABLED' : 'AUTHORITY_DISABLED',
      provider: null
    };
  }

  const existing = next.durableWorkflows.runner;
  const provider = existing?.provider;
  const executable = provider?.executable;
  const codexConfigured = existing?.kind === 'codex' || provider?.kind === 'codex'
    || isCodexExecutable(existing?.executable) || isCodexExecutable(executable);
  if (codexConfigured) {
    const authorizedCodex = existing?.enabled === true
      && provider?.kind === 'codex'
      && isCodexExecutable(executable)
      && executableFile(executable, platform)
      && codexLaunchAuthorized(next);
    if (authorizedCodex) {
      next.durableWorkflows.runner = normalizedExplicitRunner(existing);
      return {
        config: next,
        status: 'PRESERVED_EXPLICIT_OWNER_CODEX_PROVIDER',
        provider: { kind: 'codex', executable, qualifiedVersion: null }
      };
    }
    next.durableWorkflows.runner = disableRunner(existing, 'NO_CODEX_VIA_COMMANDER');
    return {
      config: next,
      status: 'CODEX_FORBIDDEN',
      provider: { kind: 'disabled', reason: 'NO_CODEX_VIA_COMMANDER' }
    };
  }

  if (existing?.enabled === true && ['command', 'claude'].includes(provider?.kind)
      && executableFile(executable, platform)) {
    next.durableWorkflows.runner = normalizedExplicitRunner(existing);
    return {
      config: next,
      status: 'PRESERVED_EXPLICIT_NON_CODEX_PROVIDER',
      provider: { kind: provider.kind, executable, qualifiedVersion: null }
    };
  }

  if (existing && typeof existing === 'object') {
    next.durableWorkflows.runner = disableRunner(existing, 'NO_AUTOMATIC_MODEL_PROVIDER');
  } else {
    next.durableWorkflows.runner = {
      enabled: false,
      autoTick: false,
      provider: { kind: 'disabled', reason: 'NO_AUTOMATIC_MODEL_PROVIDER' }
    };
  }
  return {
    config: next,
    status: existing?.enabled === true ? 'PROVIDER_MISSING_OR_UNSUPPORTED' : 'NO_AUTOMATIC_MODEL_PROVIDER',
    provider: null
  };
}
