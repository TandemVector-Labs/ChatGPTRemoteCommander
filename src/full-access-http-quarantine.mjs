/**
 * Fail-closed quarantine for legacy unauthenticated MCP HTTP on a worker
 * that could perform protected OS actions.
 *
 * This is deliberately NOT an authentication protocol. Only a separately
 * authenticated V2 ingress with owner-bound signed action grants may serve
 * commands on a privileged worker. Until that ingress is deployed, the
 * legacy /mcp dispatcher must never receive a protected request.
 */
export function legacyPrivilegedMcpQuarantine({
  platform = process.platform, configuredTier = null,
  effectiveUid = null, windowsAdminToken = null,
  // Additional strict-mode switch for STANDARD legacy clients during cutover.
  // It never disables the unconditional FULL_POWER/FULL_ACCESS quarantine.
  // Invalid values fail closed; absent/false preserves only verified non-elevated STANDARD.
  requireTrustedIngress = false,
  // Legacy powerMode can still expose privileged tools even if the tier field says STANDARD.
  legacyPowerModeEnabled = false
} = {}) {
  // A missing, malformed or unfamiliar capability tier cannot authorize
  // the legacy unauthenticated MCP listener. Preserve compatibility only
  // for independently parsed, exactly recognized non-elevated tiers.
  const profileUnverified = configuredTier !== 'STANDARD' &&
    configuredTier !== 'FULL_POWER' && configuredTier !== 'FULL_ACCESS';
  const privilegedConfig = configuredTier === 'FULL_POWER' || configuredTier === 'FULL_ACCESS';
  let privilegedProcess = false;
  let tokenUncertain = false;
  if (platform === 'linux') {
    privilegedProcess = effectiveUid === 0;
    tokenUncertain = !Number.isSafeInteger(effectiveUid) || effectiveUid < 0;
  } else if (platform === 'win32') {
    const proof = windowsAdminToken;
    privilegedProcess = proof?.ok === true && proof?.isAdmin === true &&
      proof?.elevation === 'high' && proof?.source === 'local-process-token';
    // Accept only the exact non-elevated result produced by the trusted
    // CURRENT-worker Windows token probe. "filtered" is not one of that
    // probe's outputs; the mismatch previously quarantined legitimate
    // STANDARD-only fixtures. Forged/unknown/elevated tokens stay denied.
    const verifiedNonElevated = proof?.ok === true && proof?.isAdmin === false &&
      proof?.isSystem === false && proof?.elevation === 'standard' &&
      proof?.source === 'local-process-token';
    tokenUncertain = !privilegedProcess && !verifiedNonElevated;
  } else {
    tokenUncertain = true;
  }
  const quarantine = requireTrustedIngress !== false || legacyPowerModeEnabled !== false ||
    privilegedConfig || profileUnverified || privilegedProcess || tokenUncertain;
  return Object.freeze({
    quarantine,
    code: quarantine ? 'TRUSTED_V2_INGRESS_REQUIRED' : 'LEGACY_OWNER_TOKEN_ONLY',
    privilegedProcess,
    tokenUncertain
  });
}

/** No extra headers from HTTP clients can override this boundary. */
export function rejectLegacyPrivilegedMcp(req, res, decision) {
  // An omitted, malformed or internally contradictory decision must not
  // silently reopen an unauthenticated privileged dispatcher.
  if (decision?.quarantine === false &&
      decision?.code === 'LEGACY_OWNER_TOKEN_ONLY' &&
      decision?.privilegedProcess === false &&
      decision?.tokenUncertain === false) return false;
  // Call after existing Host/Origin request admission and after /health.
  const body = Buffer.from(JSON.stringify({error:'trusted_transport_required'}));
  res.writeHead(403, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length
  });
  res.end(body);
  return true;
}
