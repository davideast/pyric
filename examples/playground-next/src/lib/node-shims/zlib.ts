/**
 * Browser shim for `node:zlib`. `just-bash`'s browser bundle does a
 * static `import { gunzipSync } from 'node:zlib'` to support a
 * `gunzip` builtin command that the playground terminal doesn't
 * actually exercise. Vite externalises `node:zlib` to
 * `__vite-browser-external`, which then fails Rollup at build time
 * because the named export doesn't resolve.
 *
 * Provide explicit no-op stubs for the names just-bash imports so
 * the build resolves cleanly. Calling any of them in the browser
 * throws — the underlying compression is genuinely unavailable; we
 * surface that loudly instead of silently returning empty bytes.
 */

function unsupported(name: string): never {
  throw new Error(`zlib.${name} is not available in the browser`);
}

export function gunzipSync(_data: unknown): Uint8Array {
  return unsupported('gunzipSync');
}

export function gzipSync(_data: unknown): Uint8Array {
  return unsupported('gzipSync');
}

export function deflateSync(_data: unknown): Uint8Array {
  return unsupported('deflateSync');
}

export function inflateSync(_data: unknown): Uint8Array {
  return unsupported('inflateSync');
}

export function brotliCompressSync(_data: unknown): Uint8Array {
  return unsupported('brotliCompressSync');
}

export function brotliDecompressSync(_data: unknown): Uint8Array {
  return unsupported('brotliDecompressSync');
}

// `constants` is imported by just-bash for zlib option flags. Stub
// with the Node-documented numeric values; if any code actually
// reads them, the consumer will fail on the call path above anyway.
export const constants = {
  Z_NO_COMPRESSION: 0,
  Z_BEST_SPEED: 1,
  Z_BEST_COMPRESSION: 9,
  Z_DEFAULT_COMPRESSION: -1,
  Z_NO_FLUSH: 0,
  Z_PARTIAL_FLUSH: 1,
  Z_SYNC_FLUSH: 2,
  Z_FULL_FLUSH: 3,
  Z_FINISH: 4,
  Z_BLOCK: 5,
  Z_TREES: 6,
} as const;

const zlib = {
  gunzipSync,
  gzipSync,
  deflateSync,
  inflateSync,
  brotliCompressSync,
  brotliDecompressSync,
  constants,
};
export default zlib;
