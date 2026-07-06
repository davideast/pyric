#!/usr/bin/env bun
/**
 * Bundle the inference Cloud Function entry to
 * `functions/inference-api/lib/index.js`.
 *
 * Bun resolves all imports at build
 * time (the shared handlers, job-store, provider adapters, sse) into
 * one self-contained file. `@inbrowser/agent` is imported type-only by
 * the adapters, so it's erased — the output has no runtime deps
 * beyond `node:*` builtins, which `target: 'node'` keeps external.
 *
 * Output goes to `lib/` (not `dist/`): @pyric/deploy's function
 * bundler ignores `dist/` but keeps `lib/`, and `package.json`'s
 * `main` points at `lib/index.js`.
 *
 * Wired into package.json `build`, before `astro build`.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const result = await Bun.build({
  entrypoints: [join(root, 'functions/inference-api/src/index.ts')],
  outdir: join(root, 'functions/inference-api/lib'),
  naming: 'index.js',
  target: 'node',
  format: 'esm',
  minify: false,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log(`Built ${join(root, 'functions/inference-api/lib/index.js')}`);
