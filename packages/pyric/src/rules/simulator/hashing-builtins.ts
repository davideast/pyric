import { Bytes } from './wrappers/bytes.js';
import { md5 as md5Bytes } from 'js-md5';
import { sha256 as sha256Bytes } from 'js-sha256';
import { EvalError } from './eval-error.js';
import { UnsupportedError } from './unsupported-error.js';

function coerceToBytes(arg: unknown): Bytes {
  if (arg instanceof Bytes) return arg;
  if (typeof arg === 'string') return Bytes.fromUtf8(arg);
  throw new EvalError(`hashing.* requires Bytes or String, got ${typeof arg}`);
}

export function evaluateHashingMethod(method: string, args: unknown[]): unknown {
  const input = coerceToBytes(args[0]);
  switch (method) {
    case 'md5': {
      // js-md5 / js-sha256 keep this path browser-safe (no node:crypto).
      // Both libs return ArrayBuffer with `.arrayBuffer()`, identical
      // bytes to the previous createHash() output — pinned by the
      // hashing.* receipt corpus.
      return new Bytes(new Uint8Array(md5Bytes.arrayBuffer(input.data)));
    }
    case 'sha256': {
      return new Bytes(new Uint8Array(sha256Bytes.arrayBuffer(input.data)));
    }
    case 'crc32': {
      const u32 = crc32(input.data);
      return new Bytes(u32ToLeBytes(u32));
    }
    case 'crc32c': {
      const u32 = crc32c(input.data);
      return new Bytes(u32ToLeBytes(u32));
    }
  }
  throw new UnsupportedError(`Unknown hashing method '${method}'`);
}

function u32ToLeBytes(n: number): Uint8Array {
  // Production serializes CRC integers least-significant byte first.
  return new Uint8Array([
    n & 0xff,
    (n >>> 8) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 24) & 0xff,
  ]);
}

// CRC32 IEEE 802.3 (polynomial 0xEDB88320, reflected).
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    c = CRC32_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// CRC32C Castagnoli (polynomial 0x82F63B78, reflected).
const CRC32C_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0x82F63B78 ^ (c >>> 1)) : (c >>> 1);
    }
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32c(data: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    c = CRC32C_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}
