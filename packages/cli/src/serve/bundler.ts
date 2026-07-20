/**
 * `pyric dev` SDK bundler — builds the browser-standalone ESM bundles the
 * import map points `firebase/*` at (`/__pyric/sdk/*.js`).
 *
 * esbuild (a real dependency — the `pyric` bin runs under node via npx, so
 * Bun.build is unavailable) bundles the wrapper entries in `entries/` with
 * SPLITTING so the shared runtime chunk holds exactly ONE sandbox per page:
 * both the auth and firestore bundles must close over the same instance.
 *
 * Two bundler plugins make pyric browser-standalone:
 *   - `pyric/*` resolver — resolves `pyric/...` specifiers from THIS package's
 *     dependency context (entries may live in a temp dir that lacks pyric).
 *   - node-builtin shims (`url`/`fs`/`path`) — still load-bearing despite the
 *     Phase U resolver split: `pyric/firestore` re-exports the agent tool
 *     factories (`firestore/index.js` → `rules/tools.js`), and tools.js
 *     statically imports the NODE module resolver. The browser path never
 *     calls into disk reads, so benign shims suffice. Droppable only when
 *     pyric breaks that static chain (tracked in #553).
 *
 * Output is cached under `~/.pyric/serve-cache/<pyric-version>-<hash>/` so a
 * warm `pyric dev` start skips the (~seconds) bundle step. `--no-cache`
 * bypasses.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

/** Modules the import map serves. Keys are the bare specifiers app code uses. */
export const SDK_MODULES = [
  'firebase/ai',
  'firebase/app',
  'firebase/auth',
  'firebase/firestore',
  'firebase/database',
  'firebase/messaging',
  'firebase/messaging/sw',
  'firebase/storage',
] as const;

/**
 * The wrapper entries shipped with @pyric/cli, located relative to this
 * module: compiled `.js` siblings when running from dist (npx install), `.ts`
 * sources in the workspace (tests / dev). esbuild bundles either.
 */
export function defaultSdkEntries(): Record<string, string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const pick = (name: string): string => {
    const js = join(here, 'entries', `${name}.js`);
    if (existsSync(js)) return js;
    const ts = join(here, 'entries', `${name}.ts`);
    if (existsSync(ts)) return ts;
    throw new Error(`pyric dev: missing SDK entry '${name}' next to ${here}`);
  };
  return {
    ai: pick('ai'),
    app: pick('app'),
    auth: pick('auth'),
    firestore: pick('firestore'),
    database: pick('database'),
    messaging: pick('messaging'),
    'messaging-sw': pick('messaging-sw'),
    storage: pick('storage'),
    init: pick('init'),
  };
}

/**
 * Resolve the built Studio app dir (the plugin's `ui` option + the CLI's
 * `--ui`). Reached by file path so @pyric/cli never imports `@pyric/studio`:
 * the packaged location (`dist/serve/studio-ui`, copied at build) or, in the
 * monorepo, the sibling studio build. Null when neither exists. The standalone
 * binary embeds these same bytes instead (see `standalone-assets.ts`).
 */
export function resolveStudioUiDir(): string | null {
  const candidates = [
    new URL('./studio-ui/', import.meta.url),
    new URL('../../../studio/dist/app/', import.meta.url),
  ];
  for (const candidate of candidates) {
    const dir = fileURLToPath(candidate);
    if (existsSync(dir)) return dir;
  }
  return null;
}

/**
 * Resolve the built docs site dir (site-docs). `pyric dev --ui` embeds it so
 * the Studio Docs tab has local docs without the hosted site. Built with base
 * `/__pyric/ui/` (see scripts/build.sh) so every page/asset/twin URL resolves
 * under the CLI mount: pages at `/__pyric/ui/docs/<slug>/`, assets at
 * `/__pyric/ui/_astro/*`, the search index at `/__pyric/ui/docs/index.json`,
 * and the shell chrome's tab links back at `/__pyric/ui/<tab>`. The dir holds
 * the site-docs `dist/` verbatim: `docs/`, `_astro/`, `index.html`, `llms.txt`.
 */
export function resolveDocsUiDir(): string | null {
  const candidates = [
    new URL('./docs-ui/', import.meta.url),
  ];
  for (const candidate of candidates) {
    const dir = fileURLToPath(candidate);
    if (existsSync(dir)) return dir;
  }
  return null;
}

// ─── pyric dist discovery ─────────────────────────────────────────────

/** Locate the installed pyric package root (works in the workspace and when
 *  @pyric/cli is npm-installed — pyric is a direct dependency). */
export function pyricPackageRoot(): string {
  // Resolve a real exported subpath, then walk up to the package root.
  const entry = fileURLToPath(import.meta.resolve('pyric/firestore'));
  let dir = dirname(entry);
  while (dir.includes(sep) && !existsSync(join(dir, 'package.json'))) {
    dir = dirname(dir);
  }
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string };
  if (pkg.name !== 'pyric') {
    throw new Error(`pyric dev: expected to resolve the pyric package, found '${pkg.name}' at ${dir}`);
  }
  return dir;
}

export function pyricVersion(root: string = pyricPackageRoot()): string {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string };
  return pkg.version ?? '0.0.0';
}

// ─── plugins ──────────────────────────────────────────────────────────

/** Resolve `pyric/*` specifiers from THIS package's own dependency context
 *  (`import.meta.resolve`) rather than from the entry file's directory —
 *  entries may live in a temp dir or the user's project, neither of which
 *  has pyric in scope; @pyric/cli always does (direct dependency). */
function pyricResolvePlugin(): esbuild.Plugin {
  return {
    name: 'pyric-serve-resolve-pyric',
    setup(build) {
      build.onResolve({ filter: /^pyric(\/|$)/ }, (args) => ({
        path: fileURLToPath(import.meta.resolve(args.path)),
      }));
    },
  };
}

/** The node builtins pyric's browser graph reaches for (via the rules module
 *  resolver). Bare and `node:`-prefixed both match. */
export const NODE_BUILTIN_RE = /^(node:)?(url|fs|path)$/;

/** Benign browser shim SOURCE per builtin (see header — droppable only when
 *  pyric breaks the `firestore/index → rules/tools → modules/resolver` static
 *  chain, #553). Exported so the Vite plugin (`./vite`) reuses the SAME shims
 *  through its own resolveId/load + optimizeDeps esbuild pass, instead of
 *  re-deriving them. */
export const NODE_BUILTIN_SHIMS: Record<string, string> = {
  fs: `const no = () => { throw new Error('pyric dev: fs is not available in the browser'); };
export const readFileSync = no; export const existsSync = () => false;
export const readdirSync = no; export const writeFileSync = no; export const mkdirSync = no;
export default { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync };`,
  url: `export const fileURLToPath = (u) => String(u).replace('file://', '');
export const pathToFileURL = (p) => new URL('file://' + p);
export default { fileURLToPath, pathToFileURL };`,
  path: `export const join = (...p) => p.join('/');
export const dirname = (p) => p.split('/').slice(0, -1).join('/') || '/';
export const resolve = (...p) => p.join('/');
export const basename = (p) => p.split('/').pop() ?? '';
export default { join, dirname, resolve, basename };`,
};

function nodeShimPlugin(): esbuild.Plugin {
  return {
    name: 'pyric-serve-node-shims',
    setup(build) {
      build.onResolve({ filter: NODE_BUILTIN_RE }, (args) => ({
        path: args.path.replace(/^node:/, ''),
        namespace: 'pyric-node-shim',
      }));
      build.onLoad({ filter: /.*/, namespace: 'pyric-node-shim' }, (args) => ({
        contents: NODE_BUILTIN_SHIMS[args.path]!,
        loader: 'js',
      }));
    },
  };
}

// ─── cache ────────────────────────────────────────────────────────────

export interface BundleOptions {
  /** Entry files (the wrapper modules in `entries/`), keyed by the served
   *  basename (`auth` → `/__pyric/sdk/auth.js`). */
  entries: Record<string, string>;
  /** Bypass the cache and build an immutable, process-independent generation. */
  noCache?: boolean;
  /** Override the cache root (tests). Default `~/.pyric/serve-cache`. */
  cacheRoot?: string;
  minify?: boolean;
}

export interface BundleResult {
  outDir: string;
  /** Served basename → absolute file path (entry bundles + shared chunks). */
  files: string[];
  cached: boolean;
  /** Release a bypass generation after its server stops. Cache generations
   *  deliberately remain durable, so their disposer is a no-op. */
  dispose(): void;
}

/** Bump when bundler logic changes in a way that must invalidate caches. */
const BUNDLER_REV = 9; // 9: cache keys also cover dependency-resolution metadata

const RESOLUTION_FILES = [
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
] as const;

function nearestPackageRoot(start: string): string | undefined {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Hash package-manager identity separately from executable source bytes.
 * Workspace dependency upgrades commonly change package.json/bun.lock before
 * the prerelease package version moves; installed packages get the same signal
 * from their consumer lockfile. Package managers own third-party byte
 * integrity, so their manifests/locks are the supported cache boundary.
 */
function packageResolutionHash(graphRoot: string, pyricRoot: string): string {
  const h = createHash('sha256');
  const cliRoot = nearestPackageRoot(graphRoot);
  for (const [label, root] of [
    ['cli', cliRoot],
    ['pyric', pyricRoot],
  ] as const) {
    if (!root) continue;
    const manifest = join(root, 'package.json');
    if (!existsSync(manifest)) continue;
    h.update(label);
    h.update(readFileSync(manifest));
  }

  let dir = cliRoot ?? graphRoot;
  while (true) {
    for (const name of RESOLUTION_FILES) {
      const file = join(dir, name);
      if (!existsSync(file)) continue;
      h.update(name);
      h.update(readFileSync(file));
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return h.digest('hex');
}

export function cacheKey(
  opts: BundleOptions,
  version: string,
  graphRoot = dirname(dirname(fileURLToPath(import.meta.url))),
  pyricRoot = pyricPackageRoot(),
): string {
  const h = createHash('sha256');
  h.update(`rev${BUNDLER_REV}`);
  h.update(version);
  // Hash the WHOLE local CLI graph, not just entries or entries/ siblings.
  // Page adapters import worker/client, worker/protocol, bridge, and verify
  // leaves outside that directory; missing one can pair a stale page client
  // with a freshly rebuilt worker. The installed pyric implementation is
  // hashed separately: workspace and prerelease builds can change dist bytes
  // without changing package.json's version.
  h.update(sourceTreeHash(graphRoot));
  h.update(sourceTreeHash(join(pyricRoot, 'dist')));
  h.update(packageResolutionHash(graphRoot, pyricRoot));
  for (const [name, file] of Object.entries(opts.entries).sort()) {
    h.update(name);
    h.update(readFileSync(file, 'utf8'));
  }
  return `${version}-${h.digest('hex').slice(0, 12)}`;
}

// ─── the bundle step ──────────────────────────────────────────────────

export async function bundleSdk(opts: BundleOptions): Promise<BundleResult> {
  const root = pyricPackageRoot();
  const version = pyricVersion(root);
  const key = cacheKey(opts, version);
  const cacheRoot = opts.cacheRoot ?? join(homedir(), '.pyric', 'serve-cache');
  mkdirSync(cacheRoot, { recursive: true });
  // A running server keeps serving this directory after bundleSdk returns.
  // Therefore `--no-cache` must never overwrite the deterministic warm-cache
  // path: another concurrent `pyric dev --no-cache` could otherwise replace
  // an entry and its shared chunks between browser requests, splitting
  // singleton module state (notably the app registry). Each bypass build gets
  // an immutable generation; the OS-level mkdir primitive makes concurrent
  // callers distinct without coordination.
  const generationRoot = opts.noCache
    ? mkdtempSync(join(cacheRoot, `.no-cache-${key}-`))
    : join(cacheRoot, key);
  const outDir = join(generationRoot, 'sdk');
  const dispose = opts.noCache
    ? () => rmSync(generationRoot, { recursive: true, force: true })
    : () => {};

  if (!opts.noCache && existsSync(join(outDir, '.complete'))) {
    const files = (readdirSync(outDir) as string[])
      .filter((f) => f.endsWith('.js'))
      .map((f) => join(outDir, f));
    return { outDir, files, cached: true, dispose };
  }

  mkdirSync(outDir, { recursive: true });
  try {
    const result = await esbuild.build({
      entryPoints: Object.fromEntries(
        Object.entries(opts.entries).map(([name, file]) => [name, file]),
      ),
      outdir: outDir,
      bundle: true,
      format: 'esm',
      platform: 'browser',
      splitting: true,
      sourcemap: 'linked',
      minify: opts.minify ?? true,
      logLevel: 'silent',
      // Provenance: any stack frame or "view source" into these bundles must
      // self-identify as the sandbox shim, not the real Firebase SDK.
      chunkNames: 'pyric-sandbox-[hash]',
      banner: {
        js: '/* pyric dev: pyric sandbox shim serving firebase/* — NOT the real Firebase SDK */',
      },
      plugins: [pyricResolvePlugin(), nodeShimPlugin()],
    });
    if (result.errors.length > 0) {
      throw new Error(
        `pyric dev: SDK bundle failed:\n${result.errors.map((e) => e.text).join('\n')}`,
      );
    }
    writeFileSync(join(outDir, '.complete'), new Date().toISOString());
    const files = (readdirSync(outDir) as string[])
      .filter((f) => f.endsWith('.js'))
      .map((f) => join(outDir, f));
    return { outDir, files, cached: false, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

// ─── the SharedWorker bundle (Phase 3c.A) ─────────────────────────────────

/**
 * Locate the SharedWorker entry (`worker/entry.ts`) — compiled `.js` sibling
 * from dist, `.ts` source in the workspace. Same dual-resolution as
 * `defaultSdkEntries`.
 */
export function workerEntryPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const js = join(here, 'worker', 'entry.js');
  if (existsSync(js)) return js;
  const ts = join(here, 'worker', 'entry.ts');
  if (existsSync(ts)) return ts;
  throw new Error(`pyric dev: missing SharedWorker entry next to ${here}`);
}

export interface WorkerBundleOptions {
  /** Where to write `worker.js` — normally the SDK bundle's `outDir` so the
   *  existing `/__pyric/sdk/<file>` route serves it with no extra wiring. */
  outDir: string;
  /** Bypass + overwrite the cached worker bundle. */
  noCache?: boolean;
  minify?: boolean;
  /** Test seam for proving epoch identity from an isolated executable graph. */
  entryPath?: string;
}

const WORKER_EPOCH_PLACEHOLDER = 'PYRIC_EPOCH_HERE';
const WORKER_EPOCH_FILE = '.worker-epoch';

/** Read the executable epoch written alongside a completed worker bundle. */
export function workerBundleEpoch(outDir: string): string {
  const epoch = readFileSync(join(outDir, WORKER_EPOCH_FILE), 'utf8').trim();
  if (!/^[a-f0-9]{16}$/.test(epoch)) {
    throw new Error(`pyric dev: invalid SharedWorker epoch in ${join(outDir, WORKER_EPOCH_FILE)}`);
  }
  return epoch;
}

/**
 * Conservative worker CACHE key. The worker bundle shares the SDK `outDir`
 * (keyed by SDK entries), which does not cover its host graph, so this broad
 * source-tree hash decides when esbuild must run again. It is intentionally NOT
 * the user-facing worker epoch: unrelated CLI changes may invalidate this cache,
 * while {@link workerBundleEpoch} is derived from the executable output and only
 * then decides whether a running SharedWorker needs replacement.
 */
export function workerSourceHash(
  pyricRoot = pyricPackageRoot(),
  graphRoot = dirname(dirname(fileURLToPath(import.meta.url))),
): string {
  const h = createHash('sha256');
  h.update(`rev${BUNDLER_REV}`);
  h.update(pyricVersion(pyricRoot));
  h.update(sourceTreeHash(join(pyricRoot, 'dist')));
  h.update(sourceTreeHash(graphRoot));
  h.update(packageResolutionHash(graphRoot, pyricRoot));
  return h.digest('hex').slice(0, 16);
}

/** Hash every JS/TS source below a directory, including split host/client leaves. */
export function sourceTreeHash(root: string): string {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
        files.push(path);
      }
    }
  };
  visit(root);
  const h = createHash('sha256');
  for (const file of files.sort()) {
    h.update(relative(root, file).split(sep).join('/'));
    h.update(readFileSync(file, 'utf8'));
  }
  return h.digest('hex');
}

/**
 * Bundle the SharedWorker entry into a single classic worker script served at
 * `/__pyric/sdk/worker.js`.
 *
 * WHY A SEPARATE BUILD (not part of `bundleSdk`'s splitting graph): a
 * SharedWorker script is loaded by URL into its OWN realm — it cannot share
 * the page's runtime chunk. So it is bundled standalone: `splitting: false`,
 * `format: 'iife'` (the client opens it with `new SharedWorker(url, { type:
 * 'classic' })`), everything inlined into one file. It reuses the same three
 * browser-standalone plugins as the SDK bundle (pyric-resolve + node-shims +
 * firebase-stub) so `pyric/*`, node builtins, and the `firebase/*` peer stubs
 * resolve identically.
 *
 * NOTE: the worker legitimately holds the whole sandbox engine — it IS the
 * backend — so this bundle is large, but it loads ONCE per origin (not per
 * page). Trimming node/admin dead paths is tracked as Phase 3b.
 *
 * The `.worker-complete` marker is independent of `bundleSdk`'s `.complete`,
 * while `cacheKey()` includes the complete CLI source graph. A worker/client
 * or protocol edit therefore invalidates the shared SDK generation too, so
 * the page and worker halves cannot come from different source generations.
 */
export async function bundleWorker(opts: WorkerBundleOptions): Promise<string> {
  const outFile = join(opts.outDir, 'worker.js');
  const marker = join(opts.outDir, '.worker-complete');
  const hash = workerSourceHash();
  if (
    !opts.noCache &&
    existsSync(outFile) &&
    existsSync(marker) &&
    existsSync(join(opts.outDir, WORKER_EPOCH_FILE)) &&
    readFileSync(marker, 'utf8') === hash
  ) {
    return outFile;
  }

  mkdirSync(opts.outDir, { recursive: true });
  const root = pyricPackageRoot();
  const result = await esbuild.build({
    entryPoints: [opts.entryPath ?? workerEntryPath()],
    outfile: outFile,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    splitting: false,
    sourcemap: 'linked',
    minify: opts.minify ?? true,
    logLevel: 'silent',
    // Reserve a fixed-width self-version slot. After esbuild writes the actual
    // executable graph, we hash that canonical output and replace this token
    // with the resulting epoch (same width, so the sourcemap stays aligned).
    define: { __PYRIC_WORKER_VERSION__: JSON.stringify(WORKER_EPOCH_PLACEHOLDER) },
    banner: {
      js: '/* pyric dev: SharedWorker sandbox host serving firebase/* — NOT the real Firebase SDK */',
    },
    plugins: [pyricResolvePlugin(), nodeShimPlugin()],
  });
  if (result.errors.length > 0) {
    throw new Error(
      `pyric dev: SharedWorker bundle failed:\n${result.errors.map((e) => e.text).join('\n')}`,
    );
  }
  const canonicalSource = readFileSync(outFile, 'utf8');
  if (!canonicalSource.includes(WORKER_EPOCH_PLACEHOLDER)) {
    throw new Error('pyric dev: SharedWorker bundle omitted its epoch placeholder');
  }
  const epoch = createHash('sha256').update(canonicalSource).digest('hex').slice(0, 16);
  writeFileSync(outFile, canonicalSource.replaceAll(WORKER_EPOCH_PLACEHOLDER, epoch));
  writeFileSync(join(opts.outDir, WORKER_EPOCH_FILE), epoch);
  writeFileSync(marker, hash);
  return outFile;
}
