/**
 * Generate an RFC 4122 version-4 UUID across secure and non-secure contexts.
 *
 * Plain-HTTP browser tabs on non-loopback hostnames run with
 * `window.isSecureContext === false`, where browsers omit `crypto.randomUUID()`
 * while retaining `crypto.getRandomValues()`. Prefers `crypto.randomUUID()`
 * when defined and falls back to 16 random bytes formatted as a canonical v4 UUID.
 */

const HEX_BYTES: readonly string[] = Array.from({ length: 256 }, (_, value) =>
  value.toString(16).padStart(2, '0'),
);

function formatUuidV4(bytes: Uint8Array): string {
  // Set version 4 (0100xxxx) and RFC 4122 variant 1 (10xxxxxx).
  const byte6 = bytes[6] ?? 0;
  const byte8 = bytes[8] ?? 0;
  bytes[6] = (byte6 & 0x0f) | 0x40;
  bytes[8] = (byte8 & 0x3f) | 0x80;

  let uuid = '';
  for (let index = 0; index < 16; index += 1) {
    if (index === 4 || index === 6 || index === 8 || index === 10) {
      uuid += '-';
    }
    const byte = bytes[index] ?? 0;
    uuid += HEX_BYTES[byte] ?? '00';
  }
  return uuid;
}

/** Return a cryptographically random RFC 4122 v4 UUID string. */
export function randomUuid(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  if (cryptoApi !== undefined && typeof cryptoApi.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    return formatUuidV4(bytes);
  }
  throw new Error('pyric: Web Crypto API is unavailable to generate a random UUID.');
}
