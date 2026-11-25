/**
 * Derive usable capabilities from the configured owner tier AND the current
 * process token observed by the host. Config flags alone never prove elevation.
 * Neither this module nor profile configuration proves ChatGPT caller identity
 * or J01 consent.
 */
function fullAccessIsOperational(accessStatus) {
  return accessStatus?.effectiveTier === 'FULL_ACCESS'
    && accessStatus?.operationalFullAccess === true
    && (accessStatus?.nativeAdmin?.verified === true
      || accessStatus?.nativeRoot?.verified === true);
}

function hostUserTokenVerified(accessStatus) {
  return accessStatus?.hostExecution?.mode === 'FULL_HOST_USER'
    && accessStatus?.hostExecution?.hostFilesystem === true
    && accessStatus?.hostExecution?.shellAvailable === true
    && (accessStatus?.nativeAdmin?.nonElevatedTokenVerified === true
      || accessStatus?.nativeRoot?.nonRootTokenVerified === true);
}

export function hasAuthorizedFullPower(config, { accessStatus = null } = {}) {
  const profile = config?.capabilityProfile;
  if (config?.powerMode?.enabled !== true || profile?.explicitlyAuthorized !== true) return false;
  if (!['STANDARD', 'FULL_POWER', 'FULL_ACCESS'].includes(profile.tier)
      || accessStatus?.configuredTier !== profile.tier) return false;
  const owner = hostUserTokenVerified(accessStatus);
  if (profile.tier === 'STANDARD') return false;
  if (profile.tier === 'FULL_POWER') {
    return accessStatus?.effectiveTier === 'FULL_POWER' && owner;
  }
  if (profile.tier !== 'FULL_ACCESS' || accessStatus?.configuredTier !== 'FULL_ACCESS') return false;
  // A non-elevated FULL_ACCESS profile may safely fall back to its verified
  // FULL_POWER owner-token scope; it never receives elevated-only actions.
  return (accessStatus?.effectiveTier === 'FULL_POWER' && owner)
    || fullAccessIsOperational(accessStatus);
}

function capabilityGranted(config, name, options = {}) {
  return hasAuthorizedFullPower(config, options)
    && !(config?.capabilityProfile?.disabledCapabilities ?? []).includes(name);
}

export function hasEffectiveFullFilesystem(config, options = {}) {
  return config?.powerMode?.fullFilesystem === true
    && capabilityGranted(config, 'filesystem.full', options);
}

export function effectivePowerMode(config, options = {}) {
  const raw = config?.powerMode ?? {};
  const enabled = hasAuthorizedFullPower(config, options);
  const gui = raw.guiControl ?? {};
  const browser = raw.browserControl ?? {};
  const mouse = gui.allowMouse === true && capabilityGranted(config, 'gui.mouse', options);
  const keyboard = gui.allowKeyboard === true && capabilityGranted(config, 'gui.keyboard', options);
  const screenshot = gui.allowScreenshot === true && capabilityGranted(config, 'gui.screenshot', options);
  const focus = gui.allowWindowFocus === true && capabilityGranted(config, 'gui.window_focus', options);
  const browserBackground = browser.enabled === true && capabilityGranted(config, 'browser.background', options);
  const processControl = raw.allowProcessControl === true && capabilityGranted(config, 'process.control', options);
  const shellExecution = raw.allowShell === true && capabilityGranted(config, 'shell.execute', options);

  return {
    ...raw,
    enabled,
    fullFilesystem: hasEffectiveFullFilesystem(config, options),
    allowShell: shellExecution,
    allowProcessControl: processControl,
    allowProcessTerminate: processControl && capabilityGranted(config, 'process.terminate', options),
    allowPersistentTerminal: processControl && shellExecution && capabilityGranted(config, 'terminal.persistent', options),
    allowPermanentDelete: raw.allowPermanentDelete === true && capabilityGranted(config, 'filesystem.permanent_delete', options),
    blockedShellPatterns: capabilityGranted(config, 'shell.unrestricted', options)
      ? raw.blockedShellPatterns : ['.*'],
    guiControl: {
      ...gui,
      enabled: enabled && gui.enabled === true && (mouse || keyboard || screenshot || focus),
      allowMouse: mouse, allowKeyboard: keyboard,
      allowWindowFocus: focus, allowScreenshot: screenshot,
      ownerAuthorizedTakeover: gui.ownerAuthorizedTakeover === true && mouse && keyboard
    },
    browserControl: {
      ...browser,
      enabled: enabled && browserBackground,
      allowInput: browserBackground && browser.allowInput === true && capabilityGranted(config, 'browser.input', options),
      allowNavigate: browserBackground && browser.allowNavigate === true && capabilityGranted(config, 'browser.navigate', options),
      allowScreenshot: browserBackground && browser.allowScreenshot === true && capabilityGranted(config, 'browser.screenshot', options),
      userBrowserProfileReuse: false
    }
  };
}
