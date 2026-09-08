/**
 * SharedWorker protocol — Storage byte payloads (base64 + size cap).
 */

/**
 * Maximum RAW byte size a single storage op may carry (`storage.putBytes`
 * payloads and `storage.getBytes` results). 8 MiB raw ≈ 11 MiB base64 —
 * comfortably under `ws`'s 100 MiB default `maxPayload` while keeping the
 * four-hop whole-object buffering (Node → bridge → page → worker and back)
 * sane. Enforced on BOTH ends: the Node conveniences / pyric-admin remote
 * arm reject before sending, and the worker host rejects oversized inputs
 * and results so a big browser-side object can't blow up the relay. Bigger
 * objects need the (unshipped) streaming story — do not raise the cap.
 */
export const MAX_STORAGE_OP_BYTES = 8 * 1024 * 1024;

/** Base64 length ceiling for a payload within {@link MAX_STORAGE_OP_BYTES} —
 *  a cheap pre-decode gate so an oversized `dataB64` is rejected without
 *  materializing its bytes first. */
export const MAX_STORAGE_OP_B64_LENGTH = Math.ceil(MAX_STORAGE_OP_BYTES / 3) * 4;

/** Build the canonical over-cap error (`code: 'payload-too-large'`). */
export function storagePayloadTooLarge(
  sizeBytes: number,
  what: string,
): Error & { code: string } {
  const err = new Error(
    `${what} is ${sizeBytes} bytes — over the ${MAX_STORAGE_OP_BYTES / (1024 * 1024)} MiB ` +
      'storage op cap (MAX_STORAGE_OP_BYTES). Streaming/resumable transfers are not ' +
      'supported on the sandbox backend; split the object or keep it under the cap.',
  ) as Error & { code: string };
  err.code = 'payload-too-large';
  return err;
}

/**
 * Encode bytes to standard base64. Chunked `String.fromCharCode` so a
 * multi-MiB payload doesn't overflow the argument-spread limit. `btoa` is
 * available in browsers, workers, Node ≥ 16, and Bun.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return btoa(binary);
}

/** Decode standard base64 to bytes (inverse of {@link bytesToBase64}). */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
