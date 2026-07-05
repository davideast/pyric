#!/usr/bin/env bun
/**
 * Browser-bundle probe — Slice A verification gate (A5 in the plan).
 *
 * What it does:
 *   1. Builds `probe-entry.ts` with Vite, target `es2022`, browser
 *      platform (Vite's default — no node platform shims).
 *   2. Inspects the emitted bundle for any `node:` built-in import that
 *      leaked through tree-shaking. Fails the probe if found.
 *   3. Imports the emitted ESM bundle and runs the probe's assertion
 *      sequence, mirroring `examples/admin-compat/sample.ts`. Browser
 *      semantics are baked into the bundle at build time via Vite's
 *      `define` (see below), so a passing import here is a faithful
 *      proxy for the bundle running in a real browser.
 *
 * Run:   bun packages/sdk/test/browser-bundle/check.ts
 *
 * Exits 0 on success, non-zero on any failure. Used as the local
 * acceptance check; CI can call this directly.
 */
import { build } from 'vite';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renameSync, rmSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(__dirname, 'probe-entry.ts');
const OUT_DIR = join(__dirname, '.dist');

// Clean any prior output so the probe always reads fresh bytes.
rmSync(OUT_DIR, { recursive: true, force: true });

console.log('1/3 building probe entry with Vite (browser target)...');
await build({
  configFile: false,
  logLevel: 'error',
  // Faithfully simulate a browser host: `process.versions.node` is
  // undefined in browsers, so we hard-code it. Without this, libraries
  // like js-md5 / js-sha256 — which sniff that global at module init to
  // pick a Node-Buffer code path — would activate the Node branch when
  // this probe is *executed* under Bun, producing a `Buffer.from`
  // reference error that wouldn't happen in a real browser. The
  // resulting bundle is a more faithful browser snapshot too.
  define: {
    'process.versions.node': 'undefined',
  },
  build: {
    outDir: OUT_DIR,
    target: 'es2022',
    minify: false,
    sourcemap: false,
    lib: {
      entry: ENTRY,
      formats: ['es'],
      fileName: 'probe',
    },
    rollupOptions: {
      // Surface any unresolved Node built-in as a build-time error
      // instead of a silent runtime ReferenceError.
      external: (id) => /^node:/.test(id),
    },
  },
});

const bundlePath = join(OUT_DIR, 'probe.js');
const bundleSrc = await Bun.file(bundlePath).text();

console.log('2/3 scanning bundle for node:* leakage...');
const nodeImports = bundleSrc.match(/\bfrom\s+["']node:[^"']+["']|\brequire\(["']node:[^"']+["']\)/g);
if (nodeImports && nodeImports.length > 0) {
  console.error(`FAIL: bundle contains node:* imports:\n  ${nodeImports.join('\n  ')}`);
  process.exit(1);
}
console.log(`     bundle is ${(bundleSrc.length / 1024).toFixed(1)} KB, no node:* imports`);

console.log('3/3 importing bundle as ESM and running probe...');
// Rename to .mjs so the host runtime treats the file as an ES module
// regardless of the nearest package.json's `type` field. The browser-
// safety guarantee comes from gates 1 + 2 (built with `target: browser`
// and zero `node:*` imports in the emitted source); step 3 just
// verifies the bundle's runtime semantics still pass the assertion
// suite.
const mjsPath = bundlePath.replace(/\.js$/, '.mjs');
renameSync(bundlePath, mjsPath);

const lines: string[] = [];
(globalThis as unknown as { __probeReport: (l: string) => void }).__probeReport =
  (l: string) => lines.push(l);

try {
  const mod = (await import(pathToFileURL(mjsPath).href)) as { runProbe: () => Promise<void> };
  await mod.runProbe();
} catch (e) {
  console.error(`FAIL: probe assertion threw — ${(e as Error).message}`);
  process.exit(1);
}

if (lines.length !== 7) {
  console.error(`FAIL: expected 7 probe steps, got ${lines.length}`);
  for (const l of lines) console.error(`  ${l}`);
  process.exit(1);
}
for (const l of lines) console.log(`     ${l}`);

console.log('\nAll three gates passed — SDK is browser-bundleable.');
