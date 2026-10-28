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
import { withWorkerBuildLock, type WorkerBuildLock } from './worker-build-lock.js';
import {
  WORKER_EPOCH_FILE,
  WORKER_FILE,
  publishWorkerBundle,
  readCompletedWorkerBundle,
  removeBuildLeftovers,
  stagingPathPrefix,
} from './worker-bundle-cache.js';

import { bridgeImportEntryKey, REAL_SDK_ENTRIES } from './firebase-module-swap.js';

export { SDK_MODULES } from './firebase-module-swap.js';

/**
 * The wrapper entries shipped with @pyric/cli, located relative to this
 * module: compiled `.js` siblings when running from dist (npx install), `.ts`
 * sources in the workspace (tests / dev). esbuild bundles either.
 */
export function defaultSdkEntries(): Record<string, string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const pick = (name: string): string => {
    const js = join(here, 'entries', `${name}.js`);
    const hasCompiledEntry = existsSync(js);
    if (hasCompiledEntry) return js;
    const ts = join(here, 'entries', `${name}.ts`);
    const hasSourceEntry = existsSync(ts);
    if (hasSourceEntry) return ts;
    throw new Error(`pyric sandbox: missing SDK entry '${name}' next to ${here}`);
  };
  return {
    ai: pick('ai'),
    analytics: pick('analytics'),
    app: pick('app'),
    'app-ai-passthrough': pick('app-ai-passthrough'),
    'app-ai-passthrough-app-check': pick('app-ai-passthrough-app-check'),
    'app-check': pick('app-check'),
    auth: pick('auth'),
    firestore: pick('firestore'),
    'firestore-lite': pick('firestore-lite'),
    functions: pick('functions'),
    database: pick('database'),
    messaging: pick('messaging'),
    'messaging-sw': pick('messaging-sw'),
    performance: pick('performance'),
    'remote-config': pick('remote-config'),
    storage: pick('storage'),
    init: pick('init'),
  };
}

/** Resolve the unified Astro documentation + Studio tree embedded by the build. */
export function resolveSiteUiDir(
  candidates: readonly string[] = [
    fileURLToPath(new URL('./site-ui/', import.meta.url)),
    fileURLToPath(new URL('../../../site-docs/dist/', import.meta.url)),
  ],
): string | null {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
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
    throw new Error(`pyric sandbox: expected to resolve the pyric package, found '${pkg.name}' at ${dir}`);
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
  fs: `const no = () => { throw new Error('pyric sandbox: fs is not available in the browser'); };
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

/**
 * Send the shadow-app wrappers' own `firebase/app` and `firebase/app-check`
 * imports to the Firebase SDK bundle `pyric sandbox` builds in production AI
 * mode (`/__pyric/sdk/firebase-sdk-*.js`). Left bare, the import map would
 * send them back to the wrappers themselves. The rule is
 * `isBypassedBridgeImport`, which the Vite and register planes read too.
 */
function bridgeImportPlugin(): esbuild.Plugin {
  return {
    name: 'pyric-serve-bridge-imports',
    setup(build) {
      build.onResolve({ filter: /^firebase\// }, (args) => {
        const key = bridgeImportEntryKey(args.path, args.importer);
        if (key === undefined) return undefined;
        return { path: `/__pyric/sdk/${key}.js`, external: true };
      });
    },
  };
}

// ─── the project's Firebase SDK (production AI mode) ─────────────────

/** The project's resolved `firebase` package. */
export interface ProjectFirebase {
  /** The package directory, as resolved from the project. */
  root: string;
  version: string;
}

/**
 * Find the `firebase` package the project's own code resolves, walking up
 * `node_modules` directories from `projectDir` as Node does. Throws a message
 * that tells the user to install it when there is none.
 */
export function resolveProjectFirebase(projectDir: string): ProjectFirebase {
  let dir = projectDir;
  while (true) {
    const manifest = join(dir, 'node_modules', 'firebase', 'package.json');
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string };
      return { root: dirname(manifest), version: pkg.version ?? '0.0.0' };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `pyric sandbox: production AI mode (${productionModeSetting(process.env)}) serves the Firebase SDK from this project, ` +
      `but no firebase package resolves from ${projectDir}. Install it with \`npm install firebase\`, ` +
      `or unset ${productionModeSetting(process.env).split('=')[0]} to answer firebase/ai from the Pyric sandbox.`,
  );
}

/**
 * The environment setting that turned production AI mode on, for messages.
 * `PYRIC_AI_MODE=production` wins; otherwise the passthrough switch did it.
 */
export function productionModeSetting(env: NodeJS.ProcessEnv): string {
  const isModeSet = env.PYRIC_AI_MODE === 'production';
  return isModeSet ? 'PYRIC_AI_MODE=production' : 'PYRIC_AI_PASSTHROUGH=1';
}

export interface ProjectFirebasePlan {
  /** Pass to `bundleSdk`; absent when the real-SDK build is skipped. */
  projectFirebase?: { projectDir: string };
  /** One line to log when the build is skipped. */
  warning?: string;
}

/**
 * Decide whether production AI mode builds the Firebase SDK. Plain
 * `pyric sandbox` serves the page itself, so a missing `firebase` throws.
 * With a child command the child resolves `firebase` on its own, so a
 * missing one only skips the build and warns.
 */
export function planProjectFirebase(projectDir: string, hasChildCommand: boolean, env: NodeJS.ProcessEnv = process.env): ProjectFirebasePlan {
  try {
    resolveProjectFirebase(projectDir);
  } catch (error) {
    if (!hasChildCommand) throw error;
    return {
      warning:
        `  ⚠ production AI mode (${productionModeSetting(env)}): no firebase package resolves from ${projectDir}, ` +
        `so the Firebase SDK is not built. Pages the sandbox serves itself (import map) need firebase installed where pyric starts; ` +
        `your command resolves firebase on its own.`,
    };
  }
  return { projectFirebase: { projectDir } };
}


const REAL_SDK_NAMESPACE = 'pyric-firebase-sdk';

/**
 * Build `firebase/app`, `firebase/ai` and `firebase/app-check` from the
 * project's `firebase` install into `outDir`, in one pass with splitting so
 * the three share one `@firebase/app` component registry, as Vite's
 * dependency optimizer does.
 */
async function bundleProjectFirebase(outDir: string, projectDir: string, firebase: ProjectFirebase, minify: boolean): Promise<void> {
  const entryPoints: Record<string, string> = {};
  for (const [specifier, key] of REAL_SDK_ENTRIES) entryPoints[key] = `${REAL_SDK_NAMESPACE}:${specifier}`;
  const result = await esbuild.build({
    entryPoints,
    outdir: outDir,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    splitting: true,
    sourcemap: 'linked',
    minify,
    logLevel: 'silent',
    chunkNames: 'firebase-sdk-[hash]',
    banner: {
      js: `/* The Firebase JS SDK, firebase@${firebase.version} from this project, built by pyric sandbox for production AI mode. */`,
    },
    plugins: [{
      name: 'pyric-serve-project-firebase',
      setup(build) {
        build.onResolve({ filter: new RegExp(`^${REAL_SDK_NAMESPACE}:`) }, (args) => ({
          path: args.path.slice(REAL_SDK_NAMESPACE.length + 1),
          namespace: REAL_SDK_NAMESPACE,
        }));
        build.onLoad({ filter: /.*/, namespace: REAL_SDK_NAMESPACE }, (args) => ({
          contents: `export * from ${JSON.stringify(args.path)};`,
          resolveDir: projectDir,
          loader: 'js',
        }));
      },
    }],
  });
  const hasBuildErrors = result.errors.length > 0;
  if (hasBuildErrors) {
    throw new Error(
      `pyric sandbox: building firebase@${firebase.version} for production AI mode failed:\n${result.errors.map((e) => e.text).join('\n')}`,
    );
  }
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
  /**
   * Production AI mode: also build the Firebase SDK from this project's own
   * `firebase` install (`/__pyric/sdk/firebase-sdk-*.js`). Absent in sandbox
   * AI mode, which neither builds nor serves it.
   */
  projectFirebase?: { projectDir: string };
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
const BUNDLER_REV = 10; // 10: wrappers import the project's Firebase SDK by URL; production keys cover it

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
  // Production AI mode also serves the project's Firebase SDK, so upgrading
  // `firebase`, or a project resolving another copy, rebuilds it.
  const projectFirebase = opts.projectFirebase;
  if (projectFirebase) {
    const firebase = resolveProjectFirebase(projectFirebase.projectDir);
    h.update(`firebase-sdk\0${firebase.root}\0${firebase.version}`);
  }
  return `${version}-${h.digest('hex').slice(0, 12)}`;
}

// ─── the bundle step ──────────────────────────────────────────────────

export async function bundleSdk(opts: BundleOptions): Promise<BundleResult> {
  // Resolved first, so a project without `firebase` fails before any build.
  const projectFirebase = opts.projectFirebase
    ? { ...opts.projectFirebase, firebase: resolveProjectFirebase(opts.projectFirebase.projectDir) }
    : undefined;
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
  const needsFreshBundle = opts.noCache === true;
  const generationRoot = needsFreshBundle
    ? mkdtempSync(join(cacheRoot, `.no-cache-${key}-`))
    : join(cacheRoot, key);
  const outDir = join(generationRoot, 'sdk');
  const dispose = needsFreshBundle
    ? () => rmSync(generationRoot, { recursive: true, force: true })
    : () => {};

  const hasCachedBundle = !needsFreshBundle && existsSync(join(outDir, '.complete'));
  if (hasCachedBundle) {
    const files = readdirSync(outDir)
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
      // Source inspection identifies the execution mode selected for this bundle.
      chunkNames: 'pyric-sandbox-[hash]',
      banner: {
        js: '/* pyric sandbox shim serving firebase/*. This is not the real Firebase SDK. */',
      },
      external: ['firebase/*'],
      plugins: [pyricResolvePlugin(), nodeShimPlugin(), bridgeImportPlugin()],
    });
    const hasBuildErrors = result.errors.length > 0;
    if (hasBuildErrors) {
      throw new Error(
        `pyric sandbox: SDK bundle failed:\n${result.errors.map((e) => e.text).join('\n')}`,
      );
    }
    if (projectFirebase) {
      await bundleProjectFirebase(outDir, projectFirebase.projectDir, projectFirebase.firebase, opts.minify ?? true);
    }
    writeFileSync(join(outDir, '.complete'), new Date().toISOString());
    const files = readdirSync(outDir)
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
  throw new Error(`pyric sandbox: missing SharedWorker entry next to ${here}`);
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
  /** Restart-required boot identity mixed into the baked worker epoch. */
  epochSalt?: string;
  /** Test seam around the build into the staging directory; `build` is the real one. */
  buildInto?: (stagingDir: string, build: () => Promise<string>) => Promise<string>;
}

const WORKER_EPOCH_PLACEHOLDER = 'PYRIC_EPOCH_HERE';

/**
 * Conservative worker CACHE key. The worker bundle shares the SDK `outDir`
 * (keyed by SDK entries), which does not cover its host graph, so this broad
 * source-tree hash decides when esbuild must run again. It is intentionally NOT
 * the user-facing worker epoch: unrelated CLI changes may invalidate this cache,
 * while the epoch returned by {@link bundleWorker} is derived from the executable output and only
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
 *
 * Builders sharing `outDir` (every project on the machine shares
 * `~/.pyric/vite-worker/<hash>`) take turns under a lock and publish from a
 * staging directory; see `worker-bundle-cache.ts`.
 */
export interface WorkerBundleResult {
  outFile: string;
  epoch: string;
}

export async function bundleWorker(opts: WorkerBundleOptions): Promise<WorkerBundleResult> {
  const outFile = join(opts.outDir, WORKER_FILE);
  const hash = workerBundleHash(opts.epochSalt);
  const reusesCache = !opts.noCache;
  const cachedEpoch = reusesCache ? readCompletedWorkerBundle(opts.outDir, hash) : null;
  if (cachedEpoch) return { outFile, epoch: cachedEpoch };

  for (let attempt = 1; ; attempt++) {
    const epoch = await withWorkerBuildLock(opts.outDir, (lock) => buildUnderLock(opts, hash, lock));
    if (epoch) return { outFile, epoch };
    const isLastAttempt = attempt >= MAX_WORKER_PUBLISH_ATTEMPTS;
    if (isLastAttempt) {
      throw new Error(`pyric sandbox: another process kept replacing the SharedWorker bundle in ${opts.outDir}`);
    }
  }
}

const MAX_WORKER_PUBLISH_ATTEMPTS = 3;

/**
 * Build and publish while holding the lock, then return the epoch of the
 * bundle on disk. That is the bundle the page is served, even when another
 * process published over ours, or null when what is on disk is torn.
 */
async function buildUnderLock(opts: WorkerBundleOptions, hash: string, lock: WorkerBuildLock): Promise<string | null> {
  // Another process may have finished this bundle while we waited.
  const builtMeanwhile = opts.noCache ? null : readCompletedWorkerBundle(opts.outDir, hash);
  if (builtMeanwhile) return builtMeanwhile;
  removeBuildLeftovers(opts.outDir);
  const stagingDir = mkdtempSync(stagingPathPrefix(opts.outDir));
  try {
    const built = await buildWhileHeld(stagingDir, opts, lock);
    if (!built) return null;
    // A builder whose lock was taken over as abandoned leaves the directory to the new holder.
    if (lock.isHeld()) publishWorkerBundle(stagingDir, opts.outDir, hash);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
  return readCompletedWorkerBundle(opts.outDir, hash);
}

/**
 * Build into `stagingDir`, or report false when the build failed after another
 * process took the lock over. A builder in another pid namespace looks exited,
 * so its lock can be taken while it still builds, and the new holder may remove
 * its staging directory. That build's failure is not this caller's error: it
 * retries under the lock and reads what the new holder published.
 */
async function buildWhileHeld(stagingDir: string, opts: WorkerBundleOptions, lock: WorkerBuildLock): Promise<boolean> {
  const build = () => buildWorkerInto(stagingDir, opts);
  try {
    await (opts.buildInto ? opts.buildInto(stagingDir, build) : build());
    return true;
  } catch (error) {
    if (lock.isHeld()) throw error;
    return false;
  }
}

/** The marker hash: the worker source graph, plus the boot salt when one is given. */
function workerBundleHash(epochSalt: string | undefined): string {
  const sourceHash = workerSourceHash();
  if (!epochSalt) return sourceHash;
  return createHash('sha256').update(sourceHash).update('\0').update(epochSalt).digest('hex');
}

/**
 * Build the worker into a private staging directory and bake its epoch.
 * The staging directory is a sibling of `outDir`, so the sourcemap's relative
 * source paths stay correct after the files move.
 */
async function buildWorkerInto(stagingDir: string, opts: WorkerBundleOptions): Promise<string> {
  const outFile = join(stagingDir, WORKER_FILE);
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
      js: '/* pyric sandbox SharedWorker host serving firebase/*. This is not the real Firebase SDK. */',
    },
    plugins: [pyricResolvePlugin(), nodeShimPlugin()],
  });
  if (result.errors.length > 0) {
    throw new Error(
      `pyric sandbox: SharedWorker bundle failed:\n${result.errors.map((e) => e.text).join('\n')}`,
    );
  }
  const canonicalSource = readFileSync(outFile, 'utf8');
  if (!canonicalSource.includes(WORKER_EPOCH_PLACEHOLDER)) {
    throw new Error('pyric sandbox: SharedWorker bundle omitted its epoch placeholder');
  }
  const epochHash = createHash('sha256').update(canonicalSource);
  if (opts.epochSalt) epochHash.update('\0').update(opts.epochSalt);
  const epoch = epochHash.digest('hex').slice(0, 16);
  writeFileSync(outFile, canonicalSource.replaceAll(WORKER_EPOCH_PLACEHOLDER, epoch));
  writeFileSync(join(stagingDir, WORKER_EPOCH_FILE), epoch);
  return epoch;
}
