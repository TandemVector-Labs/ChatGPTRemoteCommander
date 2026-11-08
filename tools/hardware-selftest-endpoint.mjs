// Only the running local Commander instance may be probed by the hardware gate.
// The listening port is deliberately variable during staged updater qualification.
export function validateHardwareSelftestEndpoint(value) {
  const denied = () => { throw new Error('SELFTEST_LOOPBACK_ONLY'); };
  if (typeof value !== 'string' || value.length > 256 || value.includes('\\')) denied();
  let url;
  try { url = new URL(value); } catch { denied(); }
  const port = Number(url.port);
  if (url.protocol !== 'http:'
    || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || !Number.isSafeInteger(port) || port < 1024 || port > 65535
    || url.pathname !== '/mcp'
    || url.username || url.password || url.search || url.hash
    || url.href !== value) denied();
  return url.href;
}
