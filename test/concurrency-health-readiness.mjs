// Test-only helper. Production server code is unchanged.
export async function waitForHealth({
  server,
  port,
  getOutput = () => '',
  platform = process.platform,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  fetchHealth = fetch,
  abortAfter = (ms) => AbortSignal.timeout(ms)
}) {
  const deadline = now() + (platform === 'win32' ? 30_000 : 15_000);
  while (now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error('server exited before health became ready: ' + getOutput());
    }
    try {
      const requestMs = Math.min(1_000, Math.max(1, deadline - now()));
      const response = await fetchHealth('http://127.0.0.1:' + port + '/health', {
        signal: abortAfter(requestMs)
      });
      if (response.ok) return;
    } catch { /* startup */ }
    await sleep(100);
  }
  throw new Error('server did not become healthy within startup deadline: ' + getOutput());
}
