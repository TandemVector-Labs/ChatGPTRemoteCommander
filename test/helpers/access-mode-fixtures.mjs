import { assessAccessStatus } from '../../src/full-access-status.mjs';

/** Test-only host-token fixture. It never changes the real process token or broker. */
export function withFullPowerAccess(context) {
  if (!context || typeof context !== 'object') throw new TypeError('TEST_ACCESS_CONTEXT_REQUIRED');
  const config = context.config ?? (context.config = {});
  config.capabilityProfile = {
    ...(config.capabilityProfile ?? {}),
    tier: 'FULL_POWER',
    explicitlyAuthorized: true,
    disabledCapabilities: config.capabilityProfile?.disabledCapabilities ?? []
  };
  config.powerMode = { ...(config.powerMode ?? {}), enabled: true };
  if (config.powerMode.blockedShellPatterns === undefined) config.powerMode.blockedShellPatterns = [];
  const hostProbeConfig = { ...config, powerMode: { ...config.powerMode, fullFilesystem: true, allowShell: true } };
  const platform = process.platform === 'win32' ? 'win32' : 'linux';
  const adminToken = platform === 'win32'
    ? { ok: true, isAdmin: false, isSystem: false, elevation: 'standard', source: 'local-process-token' }
    : null;
  const effectiveUid = platform === 'linux' ? (process.geteuid?.() || 1000) : null;
  context.accessStatus = assessAccessStatus(hostProbeConfig, null, { platform, adminToken, effectiveUid });
  return context;
}
