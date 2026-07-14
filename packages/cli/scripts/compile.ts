#!/usr/bin/env bun
/**
 * Build standalone `pyric` executables with `bun build --compile`.
 *
 * `pyric dev` normally bundles its SDK shims with esbuild at runtime, reading
 * the on-disk `pyric` dist. Neither esbuild's native helper nor that dist exist
 * inside a compiled binary's `/$bunfs`. The bundles are deterministic, though
 * (a pure function of @pyric/cli's wrapper entries + the bundled `pyric`
 * version), so we run the bundler ONCE here on the build host and embed the
 * output into the binary via a generated entry that sets
 * `globalThis.__PYRIC_EMBEDDED__` before handing off to the CLI. At runtime
 * `serve` materializes those bytes to a temp dir (see serve/standalone-assets.ts).
 *
 * Pre-req: `bun run build` (so dist/ is fresh). Then:
 *   bun scripts/compile.ts            # all four cross targets → dist-bin/
 *   bun scripts/compile.ts host       # just this machine's target (fast)
 *
 * Output lands in `dist-bin/` (NOT `dist/`, so it stays out of the npm
 * `files` allowlist — binaries are ~100 MB each and must never ship to npm).
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { embeddedAssetVersion as hashEmbeddedAssets } from './embedded-asset-version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const DIST = join(PKG_ROOT, 'dist');
const BUILD = join(PKG_ROOT, 'build'); // generated entry + embedded blobs (gitignored)
const OUT = join(PKG_ROOT, 'dist-bin'); // compiled binaries (gitignored, out of npm files)
const STAGE = join(BUILD, '.sdk-stage'); // scratch cacheRoot for the one-shot bundle

/** node platform/arch → bun --target triple. */
const TARGETS: Array<{ name: string; target: string }> = [
  { name: 'pyric-linux-x64', target: 'bun-linux-x64' },
  { name: 'pyric-linux-arm64', target: 'bun-linux-arm64' },
  { name: 'pyric-darwin-x64', target: 'bun-darwin-x64' },
  { name: 'pyric-darwin-arm64', target: 'bun-darwin-arm64' },
];

function hostTargetName(): string {
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch;
  const os = process.platform === 'darwin' ? 'darwin' : 'linux';
  return `pyric-${os}-${arch}`;
}

function die(msg: string): never {
  process.stderr.write(`compile: ${msg}\n`);
  process.exit(1);
}

// ── 0. Preconditions ──────────────────────────────────────────────────
const cliEntry = join(DIST, 'cli', 'index.js');
const bundlerMod = join(DIST, 'serve', 'bundler.js');
const studioUi = join(DIST, 'serve', 'studio-ui');
const docsUi = join(DIST, 'serve', 'docs-ui');
if (!existsSync(cliEntry) || !existsSync(bundlerMod)) {
  die(`missing build at ${DIST}. Run "bun run build" first.`);
}

const arg = process.argv[2];
const selected =
  arg === 'host'
    ? TARGETS.filter((t) => t.name === hostTargetName())
    : arg
      ? TARGETS.filter((t) => t.name === `pyric-${arg}` || t.target === arg)
      : TARGETS;
if (selected.length === 0) die(`unknown target "${arg}". Known: ${TARGETS.map((t) => t.name).join(', ')}`);

// ── 1. Build the deterministic SDK + worker bundles once (host esbuild) ─
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(BUILD, { recursive: true });

const bundler = (await import(pathToFileURL(bundlerMod).href)) as {
  bundleSdk: (o: { entries: Record<string, string>; noCache: boolean; cacheRoot: string }) => Promise<{ outDir: string }>;
  bundleWorker: (o: { outDir: string; noCache: boolean }) => Promise<string>;
  defaultSdkEntries: () => Record<string, string>;
  workerSourceHash: () => string;
  pyricVersion: () => string;
};

process.stdout.write('▸ bundling SDK shims (esbuild, one-shot)…\n');
const { outDir } = await bundler.bundleSdk({
  entries: bundler.defaultSdkEntries(),
  noCache: true,
  cacheRoot: STAGE,
});
await bundler.bundleWorker({ outDir, noCache: true });
const version = bundler.pyricVersion();
const workerVersion = bundler.workerSourceHash();

// ── 2. Collect bytes → base64 maps ────────────────────────────────────
/** SDK dir is flat. Embed `.js` only (sourcemaps are 4× the bytes and only
 *  serve devtools); strip the dangling sourceMappingURL so the page doesn't
 *  chase a 404 .map. */
function collectSdk(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.js')) continue;
    const src = readFileSync(join(dir, name), 'utf8').replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n');
    out[name] = Buffer.from(src, 'utf8').toString('base64');
  }
  return out;
}

/** Studio UI is a small tree (index.html + assets/*). Key by posix relpath. */
function collectTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else out[relative(root, abs).split(sep).join('/')] = readFileSync(abs).toString('base64');
    }
  };
  walk(root);
  return out;
}

const sdkBlob = collectSdk(outDir);
const studioBlob = existsSync(studioUi) ? collectTree(studioUi) : {};
const docsBlob = existsSync(docsUi) ? collectTree(docsUi) : {};
const assetVersion = hashEmbeddedAssets({ sdk: sdkBlob, studio: studioBlob, docs: docsBlob });
process.stdout.write(
  `  embedded ${Object.keys(sdkBlob).length} SDK file(s), ${Object.keys(studioBlob).length} studio file(s), ` +
    `${Object.keys(docsBlob).length} docs file(s) ` +
    `(pyric ${version}, worker ${workerVersion})\n`,
);

// ── 2b. Pack pyric + @pyric/cli into installable tarballs ────────────
// `pyric init --deps vendor` lays these into a scaffold so `bun install`
// resolves the still-unpublished packages offline (no registry 404). `pyric`
// packs clean (no workspace deps); `@pyric/cli` depends on `pyric` via
// workspace:* — rewrite that to `*` so it resolves from the co-installed local
// `pyric` tarball under npm/bun/pnpm alike (^0.0.0 doesn't resolve everywhere).
const MONO_ROOT = resolve(PKG_ROOT, '..', '..');
const PYRIC_DIR = join(MONO_ROOT, 'packages', 'pyric');
const TARBALL_STAGE = join(BUILD, '.tarball-stage');
rmSync(TARBALL_STAGE, { recursive: true, force: true });
mkdirSync(TARBALL_STAGE, { recursive: true });

function npmPack(pkgDir: string): string {
  const r = spawnSync('npm', ['pack', '--pack-destination', TARBALL_STAGE], {
    cwd: pkgDir,
    encoding: 'utf8',
  });
  if (r.status !== 0) die(`npm pack failed in ${pkgDir}: ${r.stderr || r.stdout}`);
  const file = (r.stdout || '').trim().split('\n').pop()!.trim();
  return join(TARBALL_STAGE, file);
}

const pyricTgz = npmPack(PYRIC_DIR);
// @pyric/cli: temporarily rewrite its `pyric` dep, pack, restore.
const cliPkgJson = join(PKG_ROOT, 'package.json');
const cliPkgOrig = readFileSync(cliPkgJson, 'utf8');
let cliTgz: string;
try {
  const parsed = JSON.parse(cliPkgOrig) as { dependencies?: Record<string, string> };
  if (parsed.dependencies?.pyric) parsed.dependencies.pyric = '*';
  writeFileSync(cliPkgJson, JSON.stringify(parsed, null, 2) + '\n');
  cliTgz = npmPack(PKG_ROOT);
} finally {
  writeFileSync(cliPkgJson, cliPkgOrig); // restore exact bytes
}

const tarballBlob: Record<string, string> = {
  'pyric.tgz': readFileSync(pyricTgz).toString('base64'),
  'pyric-cli.tgz': readFileSync(cliTgz).toString('base64'),
};
process.stdout.write(
  `  embedded tarballs: pyric.tgz (${(statSync(pyricTgz).size / 1e6).toFixed(1)} MB), ` +
    `pyric-cli.tgz (${(statSync(cliTgz).size / 1e6).toFixed(1)} MB)\n`,
);

// ── 3. Generate the embedded modules + the compile entry ──────────────
const banner = '// GENERATED by scripts/compile.ts — do not edit.\n';
writeFileSync(join(BUILD, 'embedded-sdk.js'), banner + `export default ${JSON.stringify(sdkBlob)};\n`);
writeFileSync(join(BUILD, 'embedded-studio.js'), banner + `export default ${JSON.stringify(studioBlob)};\n`);
writeFileSync(join(BUILD, 'embedded-docs.js'), banner + `export default ${JSON.stringify(docsBlob)};\n`);
writeFileSync(join(BUILD, 'embedded-tarballs.js'), banner + `export default ${JSON.stringify(tarballBlob)};\n`);
writeFileSync(
  join(BUILD, 'standalone-entry.js'),
  banner +
    `globalThis.__PYRIC_EMBEDDED__ = {\n` +
    `  version: ${JSON.stringify(version)},\n` +
    `  assetVersion: ${JSON.stringify(assetVersion)},\n` +
    `  workerVersion: ${JSON.stringify(workerVersion)},\n` +
    `  sdk: () => import('./embedded-sdk.js').then((m) => m.default),\n` +
    `  studio: () => import('./embedded-studio.js').then((m) => m.default),\n` +
    `  docs: () => import('./embedded-docs.js').then((m) => m.default),\n` +
    `  tarballs: () => import('./embedded-tarballs.js').then((m) => m.default),\n` +
    `};\n` +
    `await import(${JSON.stringify('../dist/cli/index.js')});\n`,
);
const entry = join(BUILD, 'standalone-entry.js');

// ── 4. Cross-compile ──────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });
const bun = process.execPath; // running under bun → this IS the bun binary
const built: string[] = [];
for (const t of selected) {
  const outfile = join(OUT, t.name);
  process.stdout.write(`▸ compiling ${t.name} (${t.target})…\n`);
  const r = spawnSync(
    bun,
    ['build', entry, '--compile', `--target=${t.target}`, `--outfile=${outfile}`],
    { stdio: ['ignore', 'inherit', 'inherit'], cwd: PKG_ROOT },
  );
  if (r.status !== 0) die(`bun build --compile failed for ${t.target} (exit ${r.status})`);
  built.push(outfile);
}

// Convenience: a bare `pyric` copy of the host binary for local runs / smoke.
const host = built.find((p) => p.endsWith(hostTargetName()));
if (host) copyFileSync(host, join(OUT, 'pyric'));

process.stdout.write('\n✅ standalone binaries:\n');
for (const p of [...built, ...(host ? [join(OUT, 'pyric')] : [])]) {
  process.stdout.write(`   ${relative(PKG_ROOT, p)}  (${(statSync(p).size / 1e6).toFixed(0)} MB)\n`);
}
