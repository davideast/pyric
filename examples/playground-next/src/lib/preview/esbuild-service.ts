/**
 * Singleton initializer for `esbuild-wasm`. The wasm binary is ~5MB
 * — initialize once, reuse across every recompile. Subsequent
 * `esbuild.build()` calls land on the warm service.
 *
 * `esbuild.initialize` is idempotent in the sense that calling it
 * a second time throws; we gate via a module-level promise so
 * concurrent callers all await the same init.
 *
 * The wasm URL is resolved via Vite's `?url` import — Vite copies
 * the binary into the production assets folder and fingerprints it,
 * so cache-busting and CDN-from-the-app-host work for free.
 */

import * as esbuild from 'esbuild-wasm';
import esbuildWasmUrl from 'esbuild-wasm/esbuild.wasm?url';

let initPromise: Promise<typeof esbuild> | null = null;

export function getEsbuild(): Promise<typeof esbuild> {
  if (initPromise) return initPromise;
  initPromise = esbuild
    .initialize({ wasmURL: esbuildWasmUrl, worker: true })
    .then(() => esbuild)
    .catch((err) => {
      // Reset so a later retry can succeed if init failed transiently.
      initPromise = null;
      throw err;
    });
  return initPromise;
}
