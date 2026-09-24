/**
 * SharedWorker protocol — Storage byte payloads (base64 + size cap).
 */

/**
 * Maximum RAW byte size a single storage op may carry (`storage.putBytes`
 * payloads and `storage.getBytes` results). 8 MiB raw ≈ 11 MiB base64 —
 * within the bridge's 12 MiB encoded-frame budget while keeping the
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

/**
 * Maximum RAW byte size a single chunked part may carry (`storage.putPart`).
 * 4 MiB raw ≈ 5.4 MiB base64 — well within the 12 MiB frame budget.
 */
export const MAX_STORAGE_PART_BYTES = 4 * 1024 * 1024;

/** Base64 length ceiling for a single part payload within {@link MAX_STORAGE_PART_BYTES}. */
export const MAX_STORAGE_PART_B64_LENGTH = Math.ceil(MAX_STORAGE_PART_BYTES / 3) * 4;

/**
 * Maximum total RAW byte size for a storage object transferred via chunked upload (ADR 0015).
 * 512 MiB default object limit, enforced at `beginUpload`.
 */
export const MAX_STORAGE_OBJECT_BYTES = 512 * 1024 * 1024;

/**
 * The Node host's HTTP byte route. Its paths follow Firebase's download paths
 * under the pyric namespace: `<prefix><bucket>/o/<encoded path>` for an object,
 * `<prefix><bucket>/o?name=…` for an upload.
 */
export const STORAGE_ROUTE_PREFIX = '/__pyric/storage/v0/b/';

/** An object's path on the byte route, with a token when the URL must carry its own authority. */
export function storageObjectPath(bucket: string, path: string, token?: string): string {
  const query = new URLSearchParams({ alt: 'media' });
  const hasToken = token !== undefined;
  if (hasToken) query.set('token', token);
  return `${STORAGE_ROUTE_PREFIX}${encodeURIComponent(bucket)}/o/${encodeURIComponent(path)}?${query}`;
}

/** Where one upload's bytes are sent, carrying the token bound to that upload. */
export function storageUploadPath(bucket: string, path: string, uploadId: string, token: string): string {
  const query = new URLSearchParams({ name: path, upload_id: uploadId, upload_token: token });
  return `${STORAGE_ROUTE_PREFIX}${encodeURIComponent(bucket)}/o?${query}`;
}

/** A capability token: 32 random bytes, base64url without padding. */
export function mintCapabilityToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

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

/** Build the canonical part over-cap error (`code: 'payload-too-large'`). */
export function storagePartTooLarge(
  sizeBytes: number,
  uploadId: string,
  partIndex: number,
): Error & { code: string } {
  const err = new Error(
    `Part ${partIndex} of upload '${uploadId}' is ${sizeBytes} bytes — over the ` +
      `${MAX_STORAGE_PART_BYTES / (1024 * 1024)} MiB part cap (MAX_STORAGE_PART_BYTES).`,
  ) as Error & { code: string };
  err.code = 'payload-too-large';
  return err;
}

/** Build the quota exceeded error (`code: 'storage/quota-exceeded'`). */
export function storageQuotaExceeded(
  sizeBytes: number,
  what: string,
): Error & { code: string } {
  const err = new Error(
    `${what} is ${sizeBytes} bytes — over the ${MAX_STORAGE_OBJECT_BYTES / (1024 * 1024)} MiB ` +
      'maximum storage object cap (MAX_STORAGE_OBJECT_BYTES).',
  ) as Error & { code: string };
  err.code = 'storage/quota-exceeded';
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
