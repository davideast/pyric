/**
 * Standalone-binary asset bridge.
 *
 * In a `bun build --compile` binary, `pyric serve` cannot run its esbuild SDK
 * bundler: esbuild's native helper and the on-disk `pyric` dist it scans both
 * live outside the embedded `/$bunfs` filesystem. The bundle is deterministic,
 * though — a pure function of pyric-tools' wrapper entries and the `pyric`
 * version baked into pyric-tools — so the compile step (`scripts/compile.ts`)
 * runs the bundler ONCE on the build host and embeds the output (the SDK +
 * worker bundles and the Studio UI) into the binary via
 * `globalThis.__PYRIC_EMBEDDED__`. At runtime we materialize those bytes to a
 * real temp dir so the existing serve namespace — which `createReadStream`s
 * from a directory — works unchanged.
 *
 * The npm build never sets the global. `isStandalone()` is false there and
 * `serve` keeps its runtime esbuild path untouched. The heavy base64 blobs are
 * exposed behind lazy loaders so non-`serve` commands (rules:lint, deploy, …)
 * never pay to parse them.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** The shape the compiled standalone entry installs on `globalThis`. */
export interface EmbeddedAssets {
  /** The `pyric` version the embedded bundles were built from. */
  version: string;
  /** Worker source hash stamped into the page (`<meta name="pyric-worker-v">`). */
  workerVersion: string;
  /** Lazy: flat map of SDK filename -> base64 bytes (app.js, worker.js, chunks). */
  sdk: () => Promise<Record<string, string>>;
  /** Lazy: Studio UI relpath (posix) -> base64 bytes (index.html, assets/*). */
  studio: () => Promise<Record<string, string>>;
  /** Lazy: packed npm tarballs of the unpublished workspace packages
   *  (`pyric.tgz`, `pyric-tools.tgz`) -> base64. Used by `pyric init` to vendor
   *  them into a scaffolded project so `bun install` resolves them offline
   *  instead of 404-ing on the registry. Optional so a binary built before this
   *  existed degrades gracefully. */
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

/** The worker content hash baked in at compile time (see serve.ts). */
export function embeddedWorkerVersion(): string {
  return embedded().workerVersion;
}

/** The `pyric`/`pyric-tools` version baked into this binary (for npm-mode pinning). */
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
 * Vendor the embedded `pyric` + `pyric-tools` tarballs into `<projectDir>/vendor/`
 * and return the `package.json` dep spec for each (`file:vendor/<name>.tgz`). The
 * scaffold's `.gitignore` ignores `.pyric/`, so we use `vendor/` to keep the
 * tarballs committable — a clone then `bun install`s offline. Filenames are
 * stable (`pyric.tgz`, `pyric-tools.tgz`) regardless of version.
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
    // `pyric.tgz` -> package name `pyric`; `pyric-tools.tgz` -> `pyric-tools`.
    const pkg = filename.replace(/\.tgz$/, '');
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

let sdkDirOnce: string | null = null;

/**
 * Materialize the embedded SDK + worker bundles to a temp dir and return it as
 * the `outDir` the serve namespace serves `/__pyric/sdk/*` from. Stand-in for
 * `bundleSdk()` + `bundleWorker()` in the standalone build.
 */
export async function materializeServeAssets(): Promise<{ outDir: string; cached: boolean }> {
  if (sdkDirOnce) return { outDir: sdkDirOnce, cached: true };
  const e = embedded();
  const outDir = join(tmpdir(), `pyric-serve-${e.version}`, 'sdk');
  const cached = existsSync(join(outDir, '.complete'));
  materialize(outDir, await e.sdk(), e.version);
  sdkDirOnce = outDir;
  return { outDir, cached };
}

let studioDirOnce: string | null = null;

/** Materialize the embedded Studio UI tree to a temp dir for `serve --ui`. */
export async function materializeStudioUi(): Promise<string> {
  if (studioDirOnce) return studioDirOnce;
  const e = embedded();
  const dir = join(tmpdir(), `pyric-serve-${e.version}`, 'studio-ui');
  materialize(dir, await e.studio(), e.version);
  studioDirOnce = dir;
  return dir;
}
