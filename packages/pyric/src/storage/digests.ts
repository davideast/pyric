/**
 * Isomorphic object-content digests (`md5Hash`, `crc32c`) and sandbox version
 * `etag` for Cloud Storage `StoredMetadata` (#1342).
 *
 * Encoding evidence in committed captures:
 *  - `md5Hash`: 16-byte RFC 1321 MD5 in standard RFC 4648 base64
 *    (`oracle:storage-getstorage-handle-and-md5`, `capture-s-wire.json` seq 6/7).
 *  - `crc32c`: 32-bit unsigned Castagnoli CRC32C (polynomial `0x82f63b78`)
 *    serialized most-significant byte first (4-byte big-endian, RFC 3720 /
 *    GCS JSON API `Objects.crc32c`) in standard RFC 4648 base64
 *    (`capture-s-wire.json` seq 6: `[1,2,3,4,5,6]` -> `'T037qw=='`;
 *    seq 7: `'capture s'` -> `'tO8izw=='`). Note this differs from Rules
 *    stdlib `hashing.crc32c().toBase64()`, which serializes little-endian
 *    base64url.
 *  - `etag`: `stdlib-realstorage-p2-native-object-fields` (`stored-exact`)
 *    records `resource.etag` equal to the stored object's string `etag`, while
 *    `capture-s-wire.json` and `capture-admin-wire.json` redact production's
 *    opaque `etag` to `'<etag>'`. The sandbox mints a deterministic synthetic
 *    version tag from `(generation, metageneration)` (matching
 *    `packages/cli/src/functions/storage/event.ts`) rather than claiming
 *    byte-equality with GCS's internal `etag` representation.
 */
import { createMd5Hasher, md5 } from '@pyric/rules/internal/storage';
import { arrayBufferToBase64 } from './base64.js';

const EMPTY_MD5_BASE64 = '1B2M2Y8AsgTpgAmY7PhCfg==';
const EMPTY_CRC32C_BASE64 = 'AAAAAA==';

const DIGEST_SLICE_BYTES = 64 * 1024;

const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) {
      if ((crc & 1) !== 0) {
        crc = 0x82f63b78 ^ (crc >>> 1);
      } else {
        crc = crc >>> 1;
      }
    }
    table[index] = crc >>> 0;
  }
  return table;
})();

export interface Crc32cHasher {
  update(chunk: Uint8Array): void;
  digestBase64(): string;
}

function uint8ToBase64(bytes: Uint8Array): string {
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return arrayBufferToBase64(buf);
}

function finalizeCrc32cBase64(crc: number, sawBytes: boolean): string {
  if (!sawBytes) return EMPTY_CRC32C_BASE64;
  const finalized = (crc ^ 0xffffffff) >>> 0;
  const bigEndian = new Uint8Array([
    (finalized >>> 24) & 0xff,
    (finalized >>> 16) & 0xff,
    (finalized >>> 8) & 0xff,
    finalized & 0xff,
  ]);
  return uint8ToBase64(bigEndian);
}

export function createCrc32cHasher(): Crc32cHasher {
  let crc = 0xffffffff;
  let sawBytes = false;
  return {
    update(chunk: Uint8Array): void {
      if (chunk.byteLength === 0) return;
      sawBytes = true;
      for (let index = 0; index < chunk.byteLength; index += 1) {
        const byte = chunk[index] ?? 0;
        const lookup = CRC32C_TABLE[(crc ^ byte) & 0xff] ?? 0;
        crc = lookup ^ (crc >>> 8);
      }
    },
    digestBase64(): string {
      return finalizeCrc32cBase64(crc, sawBytes);
    },
  };
}

/** Compute 4-byte big-endian Castagnoli CRC32C in standard RFC 4648 base64. */
export function computeCrc32cBase64(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) return EMPTY_CRC32C_BASE64;
  const hasher = createCrc32cHasher();
  hasher.update(bytes);
  return hasher.digestBase64();
}

/** Compute 16-byte RFC 1321 MD5 in standard RFC 4648 base64. */
export function computeMd5Base64(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) return EMPTY_MD5_BASE64;
  return uint8ToBase64(md5(bytes));
}

/**
 * Deterministic sandbox version `etag` derived from `(generation, metageneration)`.
 * Refreshes whenever content (`generation`) or metadata (`metageneration`) changes.
 */
export function computeStorageEtag(generation: string, metageneration: string): string {
  return uint8ToBase64(new TextEncoder().encode(`${generation}:${metageneration}`));
}

export interface PrecomputedBlobDigests {
  readonly md5Hash: string;
  readonly crc32c?: string;
}

const PRECOMPUTED_DIGESTS_KEY = Symbol.for('pyric.storage.precomputed-digests');
const globalPrecomputedDigests = globalThis as {
  [PRECOMPUTED_DIGESTS_KEY]?: WeakMap<Blob, PrecomputedBlobDigests>;
};
const PRECOMPUTED_DIGESTS = (globalPrecomputedDigests[PRECOMPUTED_DIGESTS_KEY] ??= new WeakMap());

/** Attach precomputed RFC 4648 base64 digests to a staged file-backed `Blob`. */
export function attachPrecomputedDigests(blob: Blob, digests: PrecomputedBlobDigests): void {
  PRECOMPUTED_DIGESTS.set(blob, digests);
}

/** Read any precomputed base64 digests attached to `blob`. */
export function precomputedDigestsOf(blob: Blob): PrecomputedBlobDigests | undefined {
  return PRECOMPUTED_DIGESTS.get(blob);
}

/** Attach a precomputed RFC 1321 base64 MD5 digest to a staged file-backed `Blob`. */
export function attachPrecomputedMd5(blob: Blob, md5Base64: string): void {
  const existing = PRECOMPUTED_DIGESTS.get(blob);
  if (existing?.crc32c !== undefined) {
    PRECOMPUTED_DIGESTS.set(blob, { md5Hash: md5Base64, crc32c: existing.crc32c });
    return;
  }
  PRECOMPUTED_DIGESTS.set(blob, { md5Hash: md5Base64 });
}

/** Read any precomputed base64 MD5 digest attached to `blob`. */
export function precomputedMd5Of(blob: Blob): string | undefined {
  return PRECOMPUTED_DIGESTS.get(blob)?.md5Hash;
}

/** Compute both `md5Hash` and `crc32c` in a single pass over `data` / `blob`. */
export async function computeBlobDigests(
  data: Blob | Uint8Array | ArrayBuffer,
  blob: Blob,
): Promise<{ md5Hash: string; crc32c: string }> {
  if (data instanceof Blob) {
    const precomputed = precomputedDigestsOf(data);
    if (precomputed?.md5Hash !== undefined && precomputed.crc32c !== undefined) {
      return { md5Hash: precomputed.md5Hash, crc32c: precomputed.crc32c };
    }
    if (blob.size === 0) {
      return {
        md5Hash: precomputed?.md5Hash ?? EMPTY_MD5_BASE64,
        crc32c: precomputed?.crc32c ?? EMPTY_CRC32C_BASE64,
      };
    }
    let md5Hasher: ReturnType<typeof createMd5Hasher> | undefined;
    if (precomputed?.md5Hash === undefined) {
      md5Hasher = createMd5Hasher();
    }
    let crcHasher: Crc32cHasher | undefined;
    if (precomputed?.crc32c === undefined) {
      crcHasher = createCrc32cHasher();
    }
    for (let offset = 0; offset < blob.size; offset += DIGEST_SLICE_BYTES) {
      const end = Math.min(offset + DIGEST_SLICE_BYTES, blob.size);
      const chunk = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
      md5Hasher?.update(chunk);
      crcHasher?.update(chunk);
    }
    let md5Hash = precomputed?.md5Hash ?? EMPTY_MD5_BASE64;
    if (md5Hasher !== undefined) {
      md5Hash = uint8ToBase64(md5Hasher.digest());
    }
    let crc32c = precomputed?.crc32c ?? EMPTY_CRC32C_BASE64;
    if (crcHasher !== undefined) {
      crc32c = crcHasher.digestBase64();
    }
    return { md5Hash, crc32c };
  }
  let bytes: Uint8Array;
  if (data instanceof Uint8Array) {
    bytes = data;
  } else {
    bytes = new Uint8Array(data);
  }
  return {
    md5Hash: computeMd5Base64(bytes),
    crc32c: computeCrc32cBase64(bytes),
  };
}
