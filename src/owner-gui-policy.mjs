// Owner-authored local configuration may enable observe-only desktop delegation.
// A Full Power profile alone never authorizes this bridge.
import fs from 'node:fs';
import path from 'node:path';

const fail = code => { throw new Error('OWNER_GUI_POLICY_' + code); };

export function mergeExplicitOwnerGuiPolicy(active, local) {
  if (!active || typeof active !== 'object' || Array.isArray(active) ||
      !local || typeof local !== 'object' || Array.isArray(local))
    fail('CONFIG_REQUIRED');
  if (!Object.hasOwn(local, 'ownerGuiDelegation')) return {config: active, merged: false};
  const requested = local.ownerGuiDelegation;
  if (!requested || typeof requested !== 'object' || Array.isArray(requested))
    fail('INVALID');
  const fields = Object.keys(requested);
  if (fields.some(k => !['enabled', 'port', 'authFile'].includes(k)) ||
      typeof requested.enabled !== 'boolean')
    fail('UNRECOGNIZED_SETTING');
  if (requested.enabled === false) {
    if (fields.length !== 1) fail('DISABLE_EXTRA_FIELDS');
    return {config: {...active, ownerGuiDelegation: {enabled: false}}, merged: true};
  }
  if (active.powerMode?.guiControl?.enabled !== true) fail('CORE_GUI_DISABLED');
  if (!Number.isSafeInteger(requested.port) || requested.port < 1024 || requested.port > 65535)
    fail('INVALID_PORT');
  const file = requested.authFile;
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.startsWith('\\\\') || file.startsWith('//'))
    fail('INVALID_AUTH_PATH');
  let st;
  try {st = fs.lstatSync(file);} catch {fail('AUTH_NOT_PRESENT');}
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) fail('AUTH_NOT_REGULAR');
  return {
    config: {...active, ownerGuiDelegation: {enabled: true, port: requested.port, authFile: path.resolve(file)}},
    merged: true
  };
}
