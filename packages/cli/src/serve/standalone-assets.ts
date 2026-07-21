/**
 * Standalone-binary asset bridge.
 *
 * In a `bun build --compile` binary, `pyric dev` cannot run its esbuild SDK
 * bundler: esbuild's native helper and the on-disk `pyric` dist it scans both
 * live outside the embedded `/$bunfs` filesystem. The bundle is deterministic,
 * though — a pure function of @pyric/cli' wrapper entries and the `pyric`
 * version baked into @pyric/cli — so the compile step (`scripts/compile.ts`)
 * runs the bundler ONCE on the build host and embeds the output (the SDK +
 * worker bundles and the Studio UI) into the binary via
 * `globalThis.__PYRIC_EMBEDDED__`. At runtime we materialize those bytes to a
 * real temp dir so the existing serve namespace — which `createReadStream`s
 * from a directory — works unchanged.
 *
 * The npm build never sets the global. `isStandalone()` is false there and
 * `serve` keeps its runtime esbuild path untouched. The heavy base64 blobs are
 * exposed behind lazy loaders so commands such as `firestore rules lint`
 * never pay to parse them.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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
   *  (`pyric.tgz`, `pyric-admin.tgz`, `create-pyric.tgz`, `pyric-cli.tgz`)
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
  if (!e) {
    throw new Error('pyric: embedded serve assets are unavailable (not a standalone build)');
  }
  return e;
}

/** The worker executable epoch baked in at compile time (see serve.ts). */
export function embeddedWorkerVersion(): string {
  return embedded().workerVersion;
}

/** The `pyric`/`@pyric/cli` version baked into this binary (for npm-mode pinning). */
export function embeddedVersion(): string {
  return embedded().version;
}

/**
 * The pyric version for user-facing strings (CLI banner, bridge / MCP server
 * version). The binary's baked version, or '0.0.0' outside a standalone build.
 * SAFE: unlike {@link embeddedVersion} it never throws — the single source these
 * strings derive from instead of hardcoding a literal in each place.
 */
export function pyricVersion(): string {
  return globalThis.__PYRIC_EMBEDDED__?.version ?? '0.0.0';
}

/** Whether this binary carries the vendorable package tarballs (see EmbeddedAssets.tarballs). */
export function hasEmbeddedTarballs(): boolean {
  return typeof globalThis.__PYRIC_EMBEDDED__?.tarballs === 'function';
}

/**
 * Vendor every embedded workspace tarball (`pyric`, `pyric-admin`,
 * `create-pyric`, `@pyric/cli`) into `<projectDir>/vendor/` and return the
 * `package.json` dep spec for each (`file:vendor/<name>.tgz`). The scaffold's
 * `.gitignore` ignores `.pyric/`, so we use `vendor/` to keep the tarballs
 * committable — a clone then `bun install`s offline. Filenames are stable
 * (version-free) so the specs never churn across versions.
 */
export async function materializeVendorTarballs(
  projectDir: string,
): Promise<Record<string, string>> {
  const e = embedded();
  if (!e.tarballs) {
    throw new Error('pyric: this binary has no embedded package tarballs to vendor');
  }
  const vendorDir = join(projectDir, 'vendor');
  mkdirSync(vendorDir, { recursive: true });
  const specs: Record<string, string> = {};
  for (const [filename, b64] of Object.entries(await e.tarballs())) {
    writeFileSync(join(vendorDir, filename), Buffer.from(b64, 'base64'));
    const pkg = filename === 'pyric-cli.tgz' ? '@pyric/cli' : filename.replace(/\.tgz$/, '');
    specs[pkg] = `file:vendor/${filename}`;
  }
  return specs;
}

/** Write a base64 file map under `root`, preserving nested relpaths, idempotently. */
function materialize(root: string, files: Record<string, string>, version: string): void {
  const marker = join(root, '.complete');
  if (existsSync(marker)) return;
  mkdirSync(root, { recursive: true });
  for (const [rel, b64] of Object.entries(files)) {
    const dest = join(root, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, Buffer.from(b64, 'base64'));
  }
  writeFileSync(marker, version);
}

function materializationRoot(e: EmbeddedAssets): string {
  const identity = e.assetVersion ? `${e.version}-${e.assetVersion}` : e.version;
  return join(tmpdir(), `pyric-serve-${identity}`);
}

let sdkDirOnce: string | null = null;

/**
 * Materialize the embedded SDK + worker bundles to a temp dir and return it as
 * the `outDir` the serve namespace serves `/__pyric/sdk/*` from. Stand-in for
 * `bundleSdk()` + `bundleWorker()` in the standalone build.
 */
export async function materializeServeAssets(): Promise<{ outDir: string; cached: boolean }> {
  if (sdkDirOnce) return { outDir: sdkDirOnce, cached: true };
  const e = embedded();
  const outDir = join(materializationRoot(e), 'sdk');
  const cached = existsSync(join(outDir, '.complete'));
  materialize(outDir, await e.sdk(), e.version);
  sdkDirOnce = outDir;
  return { outDir, cached };
}

let siteDirOnce: string | null = null;

/** Materialize the embedded Astro documentation + Studio tree for `dev --ui`. */
export async function materializeSiteUi(): Promise<string> {
  if (siteDirOnce) return siteDirOnce;
  const e = embedded();
  const dir = join(materializationRoot(e), 'site-ui');
  materialize(dir, await e.site(), e.version);
  siteDirOnce = dir;
  return dir;
}
