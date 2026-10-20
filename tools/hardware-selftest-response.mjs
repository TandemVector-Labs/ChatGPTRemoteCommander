// Cap actual HTTP response bytes *while reading*, not after response.text()
// has already buffered an attacker-controlled payload.
export const MAX_HARDWARE_SELFTEST_RESPONSE_BYTES = 2 * 1024 * 1024;

export async function readBoundedHardwareResponse(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    const bytes = Buffer.from(chunk);
    if (bytes.length > MAX_HARDWARE_SELFTEST_RESPONSE_BYTES - size) {
      const error = new Error('SELFTEST_RESPONSE_TOO_LARGE');
      error.code = 'SELFTEST_RESPONSE_TOO_LARGE';
      throw error;
    }
    size += bytes.length;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}
