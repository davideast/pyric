/**
 * Standalone-binary asset bridge.
 *
 * In a `bun build --compile` binary, `pyric dev` cannot run its esbuild SDK
 * bundler: esbuild's native helper and the on-disk `pyric` dist it scans both
 * live outside the embedded `/$bunfs` filesystem. The bundle is deterministic,
 * though -- a pure function of @pyric/cli' wrapper entries and the `pyric`
 * version baked into @pyric/cli -- so the compile step (`scripts/compile.ts`)
 * runs the bundler ONCE on the build host and embeds the output (the SDK +
 * worker bundles and the Studio UI) into the binary via
 * `globalThis.__PYRIC_EMBEDDED__`. At runtime we materialize those bytes under
 * `~/.pyric/standalone-serve/<identity>` so the existing serve namespace --
 * which `createReadStream`s from a directory -- works unchanged without writing
 * to shared `/tmp`.
 *
 * The npm build never sets the global. `isStandalone()` is false there and
 * `serve` keeps its runtime esbuild path untouched. The heavy base64 blobs are
 * exposed behind lazy loaders so commands such as `rules lint --service
 * firestore` never pay to parse them.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { touchBundleCacheDir } from './bundle-cache-evict.js';
import {
  STANDALONE_SERVE_MARKER,
  evictStandaloneServeCache,
  isAllowlistedStandaloneServeRoot,
} from './standalone-cache-evict.js';

/** The shape the compiled standalone entry installs on `globalThis`. */
export interface EmbeddedAssets {
  /** The `pyric` version the embedded bundles were built from. */
  version: string;
  /**
   * Content hash of the embedded SDK, worker, Studio, and docs trees.
   * New standalone builds use it to isolate same-version rebuilds in the
   * materialization cache. Optional so older compiled binaries still boot.
   */
  assetVersion?: string;
  /** Worker executable epoch stamped into the page (`<meta name="pyric-worker-v">`). */
  workerVersion: string;
  /** Lazy: flat map of SDK filename -> base64 bytes (app.js, worker.js, chunks). */
  sdk: () => Promise<Record<string, string>>;
  /** Lazy: unified Astro site relpath (posix) -> base64 bytes. */
  site: () => Promise<Record<string, string>>;
  /** Lazy: packed npm tarballs of the unpublished workspace packages
   *  (`pyric-rules.tgz`, `pyric.tgz`, `pyric-admin.tgz`, `create-pyric.tgz`,
   *  `pyric-cli.tgz`)
   *  -> base64. Used by `pyric init` / `pyric vendor` to vendor them into a
   *  project so `bun install` resolves them offline instead of 404-ing on the
   *  registry. Optional so a binary built before this existed degrades
   *  gracefully. */
  tarballs?: () => Promise<Record<string, string>>;
}

declare global {
  // eslint-disable-next-line no-var
  var __PYRIC_EMBEDDED__: EmbeddedAssets | undefined;
}

/** True only inside a `bun build --compile` binary produced by scripts/compile.ts. */
export function isStandalone(): boolean {
  return typeof globalThis.__PYRIC_EMBEDDED__ !== 'undefined';
}

function embedded(): EmbeddedAssets {
  const e = globalThis.__PYRIC_EMBEDDED__;
  if (e === undefined) {
    throw new Error('pyric: embedded serve assets are unavailable (not a standalone build)');
  }
  return e;
}

/** The worker executable epoch baked in at compile time (see serve.ts). */
export function embeddedWorkerVersion(): string {
  return embedded().workerVersion;
}

/** The `pyric`/`@pyric/cli` version baked in at compile time (for npm-mode pinning). */
export function embeddedVersion(): string {
  return embedded().version;
}

/** Whether this binary carries the vendorable package tarballs (see EmbeddedAssets.tarballs). */
export function hasEmbeddedTarballs(): boolean {
  return typeof globalThis.__PYRIC_EMBEDDED__?.tarballs === 'function';
}

/** The scoped packages among the embedded tarballs, by tarball filename. Every other tarball is named for its package. */
const SCOPED_TARBALL_PACKAGES: Readonly<Record<string, string>> = {
  'pyric-cli.tgz': '@pyric/cli',
  'pyric-rules.tgz': '@pyric/rules',
};

/**
 * Vendor every embedded workspace tarball (`@pyric/rules`, `pyric`,
 * `pyric-admin`, `create-pyric`, `@pyric/cli`) into `<projectDir>/vendor/` and return the
 * `package.json` dep spec for each (`file:vendor/<name>.tgz`). The scaffold's
 * `.gitignore` ignores `.pyric/`, so we use `vendor/` to keep the tarballs
 * committable -- a clone then `bun install`s offline. Filenames are stable
 * (version-free) so the specs never churn across versions.
 */
export async function materializeVendorTarballs(
  projectDir: string,
): Promise<Record<string, string>> {
  const e = embedded();
  if (e.tarballs === undefined) {
    throw new Error('pyric: this binary has no embedded package tarballs to vendor');
  }
  const vendorDir = join(projectDir, 'vendor');
  mkdirSync(vendorDir, { recursive: true });
  const specs: Record<string, string> = {};
  for (const [filename, b64] of Object.entries(await e.tarballs())) {
    writeFileSync(join(vendorDir, filename), Buffer.from(b64, 'base64'));
    let pkg = SCOPED_TARBALL_PACKAGES[filename];
    if (pkg === undefined) {
      pkg = filename.replace(/\.tgz$/, '');
    }
    specs[pkg] = `file:vendor/${filename}`;
  }
  return specs;
}

function sanitizeStandaloneIdentity(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  if (cleaned === '') {
    return 'standalone';
  }
  return cleaned;
}

function standaloneIdentity(e: EmbeddedAssets): string {
  let raw = e.version;
  if (typeof e.assetVersion === 'string' && e.assetVersion !== '') {
    raw = `${e.version}-${e.assetVersion}`;
  }
  return sanitizeStandaloneIdentity(raw);
}

/**
 * Resolves the managed standalone materialization parent root.
 * Defaults to `~/.pyric/standalone-serve`; accepts `PYRIC_STANDALONE_SERVE_CACHE_DIR`
 * only when it resolves inside `~/.pyric/standalone-serve` or `~/.cache/pyric-*`
 * (never `/tmp`, `tmpdir()`, or `$HOME`).
 */
export function resolveStandaloneServeCacheRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const overrideRaw = env.PYRIC_STANDALONE_SERVE_CACHE_DIR;
  if (typeof overrideRaw === 'string') {
    const trimmed = overrideRaw.trim();
    if (trimmed !== '' && isAllowlistedStandaloneServeRoot(trimmed)) {
      return resolve(trimmed);
    }
  }
  return resolve(join(homedir(), '.pyric', 'standalone-serve'));
}

function ensureEntryMarker(entryRoot: string, version: string): void {
  mkdirSync(entryRoot, { recursive: true });
  const markerPath = join(entryRoot, STANDALONE_SERVE_MARKER);
  if (existsSync(markerPath) === false) {
    writeFileSync(markerPath, `${version}\n`);
  }
}

/** Write a base64 file map under `root`, preserving nested relpaths, idempotently. */
function materialize(root: string, files: Record<string, string>, version: string): void {
  const marker = join(root, '.complete');
  if (existsSync(marker)) {
    return;
  }
  mkdirSync(root, { recursive: true });
  for (const [rel, b64] of Object.entries(files)) {
    const dest = join(root, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, Buffer.from(b64, 'base64'));
  }
  writeFileSync(marker, version);
}

let sdkMemo: { entryRoot: string; outDir: string } | null = null;

/**
 * Materialize the embedded SDK + worker bundles under `~/.pyric/standalone-serve/<identity>/sdk`
 * and return it as the `outDir` the serve namespace serves `/__pyric/sdk/*` from. Stand-in for
 * `bundleSdk()` + `bundleWorker()` in the standalone build.
 */
export async function materializeServeAssets(): Promise<{ outDir: string; cached: boolean }> {
  const e = embedded();
  const cacheRoot = resolveStandaloneServeCacheRoot();
  const identity = standaloneIdentity(e);
  const entryRoot = join(cacheRoot, identity);
  const outDir = join(entryRoot, 'sdk');
  if (sdkMemo !== null && sdkMemo.entryRoot === entryRoot && existsSync(join(outDir, '.complete'))) {
    touchBundleCacheDir(entryRoot);
    return { outDir: sdkMemo.outDir, cached: true };
  }
  const cached = existsSync(join(outDir, '.complete'));
  ensureEntryMarker(entryRoot, e.version);
  if (cached === false) {
    materialize(outDir, await e.sdk(), e.version);
  }
  touchBundleCacheDir(entryRoot);
  evictStandaloneServeCache(cacheRoot, identity);
  sdkMemo = { entryRoot, outDir };
  return { outDir, cached };
}

let siteMemo: { entryRoot: string; dir: string } | null = null;

/** Materialize the embedded Astro documentation + Studio tree for `dev --ui`. */
export async function materializeSiteUi(): Promise<string> {
  const e = embedded();
  const cacheRoot = resolveStandaloneServeCacheRoot();
  const identity = standaloneIdentity(e);
  const entryRoot = join(cacheRoot, identity);
  const dir = join(entryRoot, 'site-ui');
  if (siteMemo !== null && siteMemo.entryRoot === entryRoot && existsSync(join(dir, '.complete'))) {
    touchBundleCacheDir(entryRoot);
    return siteMemo.dir;
  }
  ensureEntryMarker(entryRoot, e.version);
  if (existsSync(join(dir, '.complete')) === false) {
    materialize(dir, await e.site(), e.version);
  }
  touchBundleCacheDir(entryRoot);
  evictStandaloneServeCache(cacheRoot, identity);
  siteMemo = { entryRoot, dir };
  return dir;
}
