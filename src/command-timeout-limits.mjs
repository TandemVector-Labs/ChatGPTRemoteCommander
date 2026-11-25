// Shared fail-closed numeric timeout policy for Shell and project commands.
// Never let a non-finite, coerced or overlong duration reach a Node/native timer.
export const MAX_COMMAND_TIMEOUT_MS = 3_600_000;

export function boundedCommandTimeout(requested, configured = 300_000) {
  if (!Number.isSafeInteger(configured) || configured < 1_000
    || configured > MAX_COMMAND_TIMEOUT_MS)
    throw new Error('COMMAND_TIMEOUT_POLICY_INVALID');

  if (requested === undefined || requested === null) return configured;
  if (!Number.isSafeInteger(requested) || requested < 1
    || requested > MAX_COMMAND_TIMEOUT_MS)
    throw new Error('COMMAND_TIMEOUT_INVALID');
  return Math.max(1_000, Math.min(requested, configured));
}
