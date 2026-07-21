/**
 * `@pyric/cli/vite` — the firebase→pyric-sandbox swap as a Vite plugin.
 *
 * The serve analog for SOURCE-driven apps: instead of `vite build && pyric dev
 * dist`, a team keeps `vite dev` (HMR, source maps) with the in-process sandbox
 * standing in for Firebase. The app's `firebase/*` imports are UNCHANGED — the
 * plugin swaps them at the module-resolution layer (`resolveId`), the same way
 * `pyric dev` swaps via a runtime import map. (Design: `plans/pyric-vite-plugin.md`.)
 *
 * Two flavors, one `apply` function. Under `vite dev` the swap is ALWAYS on.
 * For `vite build` the swap is MODE-gated: a plain `vite build` (mode
 * `production`) ships the real `firebase` package — the swap never reaches the
 * prod artifact — while `vite build --mode development` (any NON-production
 * mode) produces a SANDBOX build that bundles pyric's in-page adapters instead
 * of the real SDK: self-contained, meant to be previewed under `pyric dev`, and
 * stamped with the sandbox-build marker so it can never be deployed (`pyric
 * deploy hosting` refuses it). `pyric({ swapInBuild })` forces the build
 * behavior on/off regardless of mode. See `sandbox-marker.ts`.
 *
 * This is a thin adapter over serve's proven machinery. It REUSES, not reimplements:
 *   - the node-builtin shims — `NODE_BUILTIN_SHIMS`;
 *   - the swap targets — `defaultSdkEntries()` (the `serve/entries/*` wrappers,
 *     compiled-dist preferred, src fallback);
 *   - the `/__pyric/*` namespace — `createPyricNamespace` mounted verbatim behind
 *     a connect-middleware adapter;
 *   - rules load + prepare — `loadProjectRules` / `prepareRulesSource`;
 *   - the SharedWorker host — `bundleWorker` served at `/__pyric/sdk/worker.js`;
 *   - durable stores — `createStateStore` (persist) / `createCaptureStore`.
 *
 * Scope = M1 (swap + rules) + M2 (SharedWorker multi-tab + persist/capture/seed)
 * + M3 (the MCP bridge fold — `{ bridge }`). M3 reuses `createBridgeMount` (the
 * proven serve-flavored bridge behind `pyric dev --bridge`), composing it into
 * the same `/__pyric` middleware; on the worker path the bridge peer routes
 * agent tool-calls THROUGH the SharedWorker (`connectBridgePeer`), so the agent
 * and the app share one backend without forcing the page in-page.
 *
 * Serving `worker.js` flips `runtime.ts` to the worker path (one backend across
 * tabs, IndexedDB-durable); on that path the WORKER owns persist/capture/seed via
 * the same `/__pyric/*` routes. If the worker bundle fails, the plugin falls back
 * to the in-page sandbox (single-tab, ephemeral).
 */
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
import type { Plugin, UserConfig, ConfigEnv } from 'vite';
import type { Plugin as EsbuildPlugin } from 'esbuild';
import {
  SDK_MODULES,
  defaultSdkEntries,
  resolveSiteUiDir,
  pyricPackageRoot,
  NODE_BUILTIN_RE,
  NODE_BUILTIN_SHIMS,
} from './bundler.js';
import { createViteWorkerRuntime } from './vite-worker-runtime.js';
import {
  createEventHub,
  createPyricNamespace,
  type InitPayload,
} from './namespace.js';
import { formatActivityWarning } from './activity-warning.js';
import { diskWorkspace, diskProjectStore } from './studio/index.js';
import { createBridgeMount } from './bridge-mount.js';
import {
  loadProjectDatabaseRules,
  loadProjectRules,
  loadProjectStorageRules,
  prepareRulesSource,
  rulesHashOf,
} from './rules.js';
import { createStateStore, STATE_FILE_VERSION, type PyricStateFile } from './state-store.js';
import { createCaptureStore } from './capture-store.js';
import { isAllowedHost } from './server.js';
import { SANDBOX_BUILD_META } from './sandbox-marker.js';
import { readFirebaseJson, readFirebaseRc, type FirebaseJson } from '../cli/firebase-json.js';
import {
  discoverFunctionsRtdbProject,
  type FunctionsRtdbProject,
} from '../functions-rtdb/project.js';
import {
  spawnFunctionsRtdbChild,
  type FunctionsRtdbChildHandle,
} from '../functions-rtdb/child.js';
import {
  buildChildEnv,
  createLinePrefixer,
  registerModuleUrl,
} from '../cli/dev-runner.js';
import {
  loadViteAiEnv,
  resolveViteAiConfig,
  viteWorkerEpochSalt,
  type PyricAiOptions,
} from './vite-ai-config.js';
import { resolveViteRulesConfig } from './vite-rules-source.js';
import {
  PYRIC_RUNTIME_CHIP_META,
  runtimeChipMetaValue,
  type PyricRuntimeChipOption,
} from './runtime/chip-config.js';

/**
 * Whether a `vite build` should run the firebase→pyric swap (produce a SANDBOX
 * build). MODE-based with a plugin-config override:
 *   - `options.swapInBuild` wins outright when set (force on/off);
 *   - otherwise swap for any NON-production mode. A plain `vite build` (mode
 *     `production`) ships real firebase; `vite build --mode development` (or any
 *     custom non-prod mode) is a sandbox build.
 * `vite dev` is handled separately in `apply` (always on).
 */
function swapsInBuild(env: ConfigEnv, swapInBuild: boolean | undefined): boolean {
  if (swapInBuild !== undefined) return swapInBuild;
  return env.mode !== 'production';
}

/** Any `firebase/<sub>` specifier. */
const FB_ANY = /^firebase\/([a-z-]+(?:\/[a-z-]+)*)$/;

/** The firebase subpaths with swap entries. */
const SERVED = new Set(SDK_MODULES.map((specifier) => specifier.slice('firebase/'.length)));
const entryKey = (subpath: string): string => subpath.replaceAll('/', '-');
const NODE_SHIM_PREFIX = '\0pyric:node-shim:';

/** Walk up from a file to the nearest directory containing a package.json. */
function packageRootOf(file: string): string {
  let dir = path.dirname(file);
  while (dir !== path.dirname(dir) && !existsSync(path.join(dir, 'package.json'))) {
    dir = path.dirname(dir);
  }
  return dir;
}

export interface PyricOptions {
  /** Firestore rules path (relative to `root`). Default discovery prefers an
   *  authored `firestore.modules.rules`, then `firebase.json`, then
   *  `firestore.rules` in the project root. */
  rules?: string;
  /** Project dir for `firebase.json` / rules discovery. Default: Vite's `root`. */
  root?: string;
  /** Persist sandbox state to `.pyric/state/state.json` so data + test users
   *  survive reloads/restarts. Off by default (ephemeral). */
  persist?: boolean;
  /** With `persist`: discard any existing state file and re-seed from scratch. */
  fresh?: boolean;
  /** Write the live session fixture to `.pyric/last-session.json` (for
   *  `pyric verify`). Default `true`; pass `false` to suppress. */
  capture?: boolean;
  /** Seed file: a `"collection/doc" → fields` JSON map, or a `pyric snapshot`
   *  state-file envelope. Applied at page init (state wins once it exists). */
  seed?: string;
  /** Mount the MCP **bridge** on Vite's dev origin so an external agent
   *  (Claude Code, Cursor) can drive this sandbox over MCP — `POST /__pyric/mcp`
   *  + `GET /__pyric/health` + `WS /__pyric/sandbox`, all on Vite's port.
   *  `true` is shorthand for `{}`. The agent and the page share ONE sandbox.
   *
   *  Does NOT change the sandbox topology: on the default SharedWorker path the
   *  page dials the bridge WS and relays agent tool-calls THROUGH the worker
   *  (`connectBridgePeer`), so multi-tab stays on. The in-page fallback engages
   *  only when the worker bundle itself fails, bridge or not. */
  bridge?: boolean | { project?: string; disableAuditLog?: boolean };
  /** Serve the **Pyric Studio** app at `/__pyric/ui/` on Vite's dev origin (the
   *  `pyric dev --ui` equivalent). Mounts the disk-backed workspace/project
   *  routes Studio's `local` mode talks to AND serves the unified Astro site
   *  (vendored in this package at `dist/serve/site-ui`). **On by default**,
   *  including under `bridge` (the bridge peer routes through the SharedWorker,
   *  so app, Studio, and agent all observe the one sandbox); pass `ui: false`
   *  to disable. */
  ui?: boolean;
  /** Inject the collapsed Pyric runtime chip into the app during sandbox Vite
   *  dev/builds. On by default. Pass `false` to hide it, or
   *  `{ initiallyOpen: true }` when actively debugging runtime errors. */
  runtimeChip?: PyricRuntimeChipOption;
  /** RTDB-triggered Cloud Functions under this dev server (the `pyric dev`
   *  parity fold). By default a `functions` block in `firebase.json` is
   *  discovered automatically: its `onValueCreated` triggers run in an isolated
   *  node child against the shared sandbox (other trigger kinds warn and are
   *  skipped), and the discovered codebase turns the MCP bridge mount on (the
   *  child dials the sandbox over the bridge WS — the page's sandbox topology
   *  is unchanged, see `bridge`). `functions: false` is the off switch: no
   *  discovery, no child, no functions-forced bridge mount.
   *
   *  Field precedence: explicit option > env var > firebase files > default.
   *  - `region`: the trigger location. Beats `PYRIC_FUNCTIONS_RTDB_REGION`;
   *    default `us-central1`.
   *  - `instance`: the RTDB instance name. Default `<projectId>-default-rtdb`,
   *    where projectId is `PYRIC_PROJECT`, else `.firebaserc`'s default
   *    project, else `demo-project`.
   *  - `watch`: hot-reload the functions source (default `true`, matching
   *    rules). A save under the functions source dir stops the child and
   *    respawns it — redeploy semantics: in-flight executions in the old child
   *    may drop, and writes landing during the swap gap are consumed as the new
   *    child's baseline (they do not fire). Unlike rules, a broken save cannot
   *    keep last-good live — the old child is already gone — so functions stay
   *    down until the next good save. */
  functions?: false | { region?: string; instance?: string; watch?: boolean };
  /** Force whether `vite build` runs the firebase→pyric swap, overriding the
   *  mode default. Unset (default): swap for any NON-production mode, keep real
   *  firebase for mode `production`. `true` = always produce a sandbox build;
   *  `false` = never swap in build (real firebase regardless of mode). `vite
   *  dev` is unaffected — the swap is always on there. */
  swapInBuild?: boolean;
  /**
   * Dev-server-level AI configuration for `pyric/ai` (the sanctioned
   * replacement for threading `engine` through every app `getAI(...)` call,
   * which is first-call-wins and easy to get wrong).
   *
   *   pyric({
   *     ai: {
   *       model: 'llama3.2',
   *       proxyUpstream: 'http://localhost:11434/v1', // your Ollama
   *     },
   *   })
   *
   * - `model` is the simple OpenAI-compatible path. It uses the same-origin
   *   proxy and becomes the catch-all upstream model. `PYRIC_AI_MODEL` selects
   *   the same path when neither `model` nor `engine` is explicit.
   * - `engine` is `pyric/ai`'s `EngineConfig` (scripted | openai), applied on
   *   both the SharedWorker and in-page paths. An openai `baseUrl` of
   *   `/__pyric/ai-proxy` (or omitted) routes through the same-origin proxy so a
   *   localhost upstream needs zero CORS setup.
   * - `proxyUpstream` sets what `/__pyric/ai-proxy` forwards to (beats the
   *   `PYRIC_AI_PROXY_UPSTREAM` env var; default `http://localhost:11434/v1`).
   *
   * Precedence: explicit `engine` or `model`, then `PYRIC_AI_MODEL`, then an
   * engine passed by the app's first `getAI()` call; with none, the zero-config
   * scripted default applies. `model` and `engine` are mutually exclusive.
   */
  ai?: PyricAiOptions;
}

/**
 * The dev-only Vite plugin. Add to `vite.config`:
 *
 *   import { pyric } from '@pyric/cli/vite';
 *   export default defineConfig({ plugins: [pyric()] });
 */
export function pyric(options: PyricOptions = {}): Plugin {
  let resolvedAi = resolveViteAiConfig(options.ai, {});
  // Resolved once. `defaultSdkEntries()` prefers compiled dist `.js` and falls
  // back to source `.ts` in the workspace.
  const entries = defaultSdkEntries(); // { app, auth, firestore, init } → abs paths
  const pyricRoot = pyricPackageRoot();
  // The @pyric/cli package root — covers the served entries AND their siblings
  // (`worker/client.js`, the bridge client) that the entries statically import.
  const cliRoot = packageRootOf(entries.init);

  // section 8 refinement: a firebase import is "pyric-internal" iff its importer lives
  // under the resolved pyric package root — keyed on the root, not a `/pyric/`
  // substring (which a user project path could false-positive).
  const isPyricImporter = (importer: string | undefined): boolean => {
    if (!importer) return false;
    const f = importer.split('?')[0];
    return f === pyricRoot || f.startsWith(pyricRoot + path.sep);
  };
  // Node builtins are reached only from OUR code (pyric internals + the served
  // entries) — shim those, but NEVER hijack a user app or third-party library's
  // own `fs`/`path`/`url` (which Vite, or the user's polyfill plugin, should
  // resolve). The firebase branch stays scoped to pyric; this is the wider "ours".
  const isOurCode = (importer: string | undefined): boolean => {
    if (!importer) return false;
    if (isPyricImporter(importer)) return true;
    const f = importer.split('?')[0];
    return f === cliRoot || f.startsWith(cliRoot + path.sep);
  };
  const shimFor = (spec: string): string => NODE_BUILTIN_SHIMS[spec.replace(/^node:/, '')]!;

  // The esbuild mirror for Vite's dep optimizer — REQUIRED so a node_modules
  // library's `firebase/*` swaps too (the optimizer's esbuild pass bypasses the
  // Rollup-pipeline resolveId below and would otherwise pre-bake real firebase).
  const esbuildMirror: EsbuildPlugin = {
    name: 'pyric-sandbox-optimizer',
    setup(build) {
      build.onResolve({ filter: FB_ANY }, (args) => {
        const sub = FB_ANY.exec(args.path)![1]!;
        if (SERVED.has(sub)) return { path: entries[entryKey(sub)]! };
        return null; // non-served firebase from a lib → real firebase
      });
      build.onResolve({ filter: NODE_BUILTIN_RE }, (args) => {
        if (!isOurCode(args.importer)) return null; // user/lib node builtins → Vite/their polyfill
        return { path: args.path.replace(/^node:/, ''), namespace: 'pyric-node-shim' };
      });
      build.onLoad({ filter: /.*/, namespace: 'pyric-node-shim' }, (args) => ({
        contents: NODE_BUILTIN_SHIMS[args.path]!,
        loader: 'js',
      }));
    },
  };

  // Live rules box — the watcher swaps it; the init payload always serves the
  // current version.
  const live: {
    rules: string | null;
    rulesHash: string | null;
    databaseRules: { rules: Record<string, unknown> } | null;
    databaseRulesHash: string | null;
    databaseUrl: string | null;
    storageRules: string | null;
    storageRulesHash: string | null;
  } = {
    rules: null,
    rulesHash: null,
    databaseRules: null,
    databaseRulesHash: null,
    databaseUrl: null,
    storageRules: null,
    storageRulesHash: null,
  };

  // M2: the SharedWorker bundle's content hash (sync) — stamped into the page so
  // a still-running OLD worker is detected as stale. The collaborator becomes
  // ready once its bundle succeeds; until then (or on bundle failure) the page
  // is forced onto the in-page sandbox path. transformIndexHtml reads its tag.
  const workerRuntime = createViteWorkerRuntime();

  // Set by the `config` hook. When the plugin runs under `vite build` at all it
  // is a SANDBOX build (the `apply` gate below only lets build through under the
  // sandbox trigger), so `command === 'build'` is sufficient to know we are
  // producing marker-stamped, non-production output.
  let sandboxBuild = false;
  // Sandbox build: the serve init entry (runtime bootstrap + the ServeAuthHelper
  // popup picker) is emitted as its OWN chunk and script-tagged into index.html.
  // Rollup dedupes the shared runtime module between this chunk and the app
  // chunk (both import the same absolute file), so the page runs exactly ONE
  // sandbox runtime — unlike serve-time injection of /__pyric/sdk/init.js,
  // which is a separately-bundled second runtime copy (the double-init bug:
  // two banners, two bridge registrations). `pyric dev` sees the marker and
  // skips its injection for these pages (see injectServeTags).
  let initChunkRef: string | undefined;
  let initChunkFile: string | undefined;

  // M3 bridge fold: normalize `bridge` once (true ⇒ `{}`, falsy ⇒ null). When
  // on, the MCP mount is composed into the /__pyric middleware (createBridgeMount,
  // shared with `pyric dev --bridge`) AND the page is forced onto the in-page
  // sandbox path — the bridge peer is the in-page sandbox, never the SharedWorker,
  // so multi-tab is disabled under bridge to keep agent + app on one backend.
  const bridgeOpts = options.bridge === true ? {} : options.bridge || null;

  // Plugin-level AI engine, normalized to the JSON-safe wire shape. Travels
  // to the worker host via the init payload (→ ctx.aiEngine) AND to the in-page
  // fallback via an injected synchronous global (see transformIndexHtml).
  // An explicit engine is available immediately (some hook tests call the HTML
  // transform directly); Vite's config hook may otherwise select the simple
  // PYRIC_AI_MODEL environment path for the active mode/root.
  return {
    name: 'pyric:sandbox',
    // Active for `vite dev` ALWAYS, and for `vite build` only when it is a
    // SANDBOX build (any non-`production` mode, or `swapInBuild: true`). A plain
    // `vite build` keeps the real firebase package — the swap never reaches
    // production output. A sandbox build applies the same swap so the output
    // bundles pyric's in-page adapters (self-contained; preview it under
    // `pyric dev`, never deploy it).
    apply(config, env) {
      void config;
      if (env.command === 'serve') return true;
      return swapsInBuild(env, options.swapInBuild);
    },
    enforce: 'pre',

    config(config, env) {
      sandboxBuild = env.command === 'build';
      const loadedEnv = loadViteAiEnv(env.mode, config.root, config.envDir);
      resolvedAi = resolveViteAiConfig(options.ai, loadedEnv);
      // Cast: the `esbuild` package's `Plugin` type skews slightly from Vite's
      // bundled esbuild types (benign — the Plugin shape is stable across the
      // versions in range).
      return {
        optimizeDeps: {
          // Keep firebase out of the optimizer's pre-bake; the resolver swaps it
          // per-importer at request time.
          exclude: [...SDK_MODULES],
          // The excluded SDK is served as ESM straight from dist, so Vite never
          // scans it for dependencies. js-md5 / js-sha256 are CJS-only (no ESM
          // named exports); without a forced pre-bundle the browser gets the raw
          // UMD source and `import { md5 }` throws a SyntaxError. Force-including
          // them gives the dist imports the interop-wrapped optimized copies.
          include: ['js-md5', 'js-sha256'],
          esbuildOptions: { plugins: [esbuildMirror] },
        },
        // Sandbox build only: the swapped-in runtime chunk uses TOP-LEVEL AWAIT
        // (it deploys rules before app code runs — load-bearing, see
        // entries/runtime.ts). Vite's default build target predates TLA and the
        // esbuild transpile would fail. A sandbox build is a throwaway preview
        // served under `pyric dev` (modern browser), so pin an ESNext target
        // that keeps TLA. A plain production `vite build` never runs this plugin,
        // so the user's own target is untouched there.
        ...(sandboxBuild ? { build: { target: 'esnext' } } : {}),
      } as unknown as UserConfig;
    },

    configResolved(resolved) {
      // AUGMENT (don't replace) the fs allow-list: pyric dist + the @pyric/cli
      // tree live outside the app root, but setting `server.fs.allow` in config()
      // would clobber Vite's auto-added root/workspace entries and 403 the app's
      // own source. Push the two PACKAGE ROOTS — @pyric/cli' root (not just the
      // entries dir) is needed because the served init entry statically imports
      // siblings (`worker/client.js`, the bridge client) outside entries/.
      const allow = resolved.server?.fs?.allow;
      if (allow) {
        for (const dir of [pyricRoot, cliRoot]) {
          if (!allow.includes(dir)) allow.push(dir);
        }
      }
    },

    resolveId(source, importer) {
      const fb = FB_ANY.exec(source);
      if (fb) {
        const sub = fb[1]!;
        if (SERVED.has(sub)) return entries[entryKey(sub)]!; // swap served set for user/lib
        return null; // non-served firebase from user → real firebase
      }
      const node = NODE_BUILTIN_RE.exec(source);
      // Shim node builtins ONLY when reached from our own code — never hijack a
      // user app or library's own fs/path/url (Vite/their polyfill handles those).
      if (node && isOurCode(importer)) return NODE_SHIM_PREFIX + node[2]!;
      return null;
    },

    load(id) {
      if (id.startsWith(NODE_SHIM_PREFIX)) return shimFor(id.slice(NODE_SHIM_PREFIX.length));
      return null;
    },

    async configureServer(server) {
      const cwd = options.root ?? server.config.root;

      // Reproduce serve's rules prelude: firebase.json (optional) → loadProjectRules.
      let fbJson: FirebaseJson | null = null;
      try {
        fbJson = await readFirebaseJson(cwd);
      } catch {
        /* optional — serve without a firebase.json */
      }
      // Convention-first development source: an explicit option wins; otherwise
      // an authored 2+modules file wins over firebase.json's generated deployment
      // target. Projects without that convention retain the normal Firebase
      // discovery path.
      const config = resolveViteRulesConfig(cwd, options.rules, fbJson);
      const loaded = await loadProjectRules(cwd, config);
      const loadedDatabase = await loadProjectDatabaseRules(cwd, config);
      const loadedStorage = await loadProjectStorageRules(cwd, config);
      live.rules = loaded.rules;
      live.rulesHash = loaded.rulesHash;
      live.databaseRules = loadedDatabase.rules;
      live.databaseRulesHash = loadedDatabase.rulesHash;
      live.databaseUrl = loadedDatabase.databaseUrl;
      live.storageRules = loadedStorage.rules;
      live.storageRulesHash = loadedStorage.rulesHash;

      // ── M2 durable stores (mirrors serve's startServe orchestration) ──────
      // Capture (default-on): the worker/page pushes its session fixture to
      // /__pyric/capture; the store writes .pyric/last-session.json for `pyric verify`.
      const capture = (options.capture ?? true) ? createCaptureStore(cwd) : undefined;
      // Persist: createStateStore IS the durable sandbox. Load eagerly so a
      // corrupt/mismatched file fails the start (not silently ephemeral).
      const state = options.persist ? createStateStore(cwd) : undefined;
      if (state && options.fresh) {
        for (const p of [state.path, state.backupPath]) if (existsSync(p)) rmSync(p);
        server.config.logger.info('  ⓘ [pyric] fresh: discarded the existing state file; re-seeding');
      }
      // Eager load (mirrors serve.ts:158) — parse the file NOW so a corrupt or
      // version-mismatched state file throws StateFileError and FAILS THE START
      // with the actionable inspect-or-delete message. Without this the first
      // parse is deferred into initPayload() at request time, where it throws
      // synchronously AFTER namespace.ts has committed `writeHead(200)`: the
      // client gets a 200 with an empty body, the page/worker swallow the JSON
      // error, and the sandbox silently runs WITHOUT the persisted data + rules.
      // (No-op on first run: load() returns null for a missing file.)
      // configureServer is async, so an uncaught throw aborts the dev start.
      if (state) state.load();

      // Seed: a "collection/doc" → fields map, OR a `pyric snapshot` state-file
      // envelope (detected by its `version` key). Ported from serve.ts.
      let seed: Record<string, Record<string, unknown>> | null = null;
      let seedState: unknown | null = null;
      let seedUsers: Record<string, unknown>[] | null = null;
      if (options.seed) {
        const seedPath = path.resolve(cwd, options.seed);
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(seedPath, 'utf8'));
        } catch (e) {
          throw new Error(`@pyric/cli/vite: failed to read seed ${seedPath}: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('@pyric/cli/vite: seed must be a JSON object of "collection/doc" → fields');
        }
        const obj = parsed as Record<string, unknown>;
        if (obj.version === STATE_FILE_VERSION && ('firestore' in obj || 'auth' in obj)) {
          const fixture = obj as unknown as PyricStateFile;
          if (state && !state.exists()) {
            // persist first run from a fixture: prime the store, then the normal
            // persist path restores it like any lived state.
            if (fixture.firestore != null) state.writeSection('firestore', fixture.firestore);
            if (fixture.auth != null) state.writeSection('auth', fixture.auth);
          } else if (!state) {
            seedState = fixture.firestore ?? null;
            seedUsers = (fixture.auth?.users as Record<string, unknown>[] | undefined) ?? null;
          }
          // persist + existing state: lived state wins; the fixture is inert.
        } else {
          seed = parsed as Record<string, Record<string, unknown>>;
        }
      }

      // ── M2 SharedWorker host: bundle it (cached per version) and serve it at
      // /__pyric/sdk/worker.js. This is what flips runtime.ts to the worker path.
      // On bundle failure, the collaborator stays unready and its HTML tag
      // forces the in-page sandbox.
      try {
        await workerRuntime.prepare(viteWorkerEpochSalt(cwd, resolvedAi.engineWire));
      } catch (e) {
        server.config.logger.warn(
          `  ⚠ [pyric] SharedWorker bundle failed — using the in-page sandbox (single-tab, ephemeral): ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      // ── Functions (RTDB triggers) — the `pyric dev` parity fold ───────────
      // Discover the one supported Functions codebase from the same resolved
      // firebase.json the rules used (project.ts reads it itself). Reuses the
      // exact serve module, so absent `functions` → null (silently off) and a
      // malformed config throws serve's own error text — which, thrown from an
      // async configureServer, fails the dev start the same way serve's
      // `return 2` aborts. The Functions child connects to the sandbox over the
      // bridge WS, so a discovered codebase forces the bridge mount on (mirrors
      // serve's `bridgeEnabledFor(..., functionsProject)`). `functions: false`
      // is the off switch: discovery never runs, so neither does the mount.
      const functionsOpts = typeof options.functions === 'object' ? options.functions : {};
      let functionsProject: FunctionsRtdbProject | null = null;
      if (options.functions !== false) {
        try {
          functionsProject = discoverFunctionsRtdbProject(cwd);
        } catch (error) {
          // Malformed functions config: fail the start with serve's exact message.
          throw error instanceof Error ? error : new Error(String(error));
        }
      }
      const functionsProjectId = functionsProject
        ? (process.env.PYRIC_PROJECT ?? (await readFirebaseRc(cwd))?.projects?.default ?? 'demo-project')
        : null;

      // ── M3 MCP bridge (mirrors serve.ts:221–274) ─────────────────────────
      // The mount is long-lived (one bridge per dev session); its MCP transport
      // is rebuilt per request (stateless). Composed into the /__pyric middleware
      // below (handler tier) + the server's WS upgrade. middlewareMode has no
      // httpServer → HTTP routes still work, no WS peer.
      // Guard the WS upgrade with the SAME allow rule Vite's own host check
      // uses (host + allowedHosts, where `true` = opted into all hosts). Vite's
      // upgrade path bypasses connect middleware, so this is the only guard on it.
      const mount = bridgeOpts || functionsProject
        ? createBridgeMount({
            ...(bridgeOpts ?? {}),
            // A functions-only session still needs a labeled bridge; prefer an
            // explicit bridge project, else the resolved functions project id.
            project: bridgeOpts?.project ?? functionsProjectId ?? undefined,
            upgradeGuard: {
              boundHost: typeof server.config.server.host === 'string' ? server.config.server.host : 'localhost',
              allowedHosts:
                server.config.server.allowedHosts === true
                  ? true
                  : Array.isArray(server.config.server.allowedHosts)
                    ? server.config.server.allowedHosts
                    : [],
            },
          })
        : null;

      // The /__pyric/* namespace, reused VERBATIM (now with the sdk dir + state +
      // capture routes live).
      const events = createEventHub();
      const initPayload = (): InitPayload => ({
        rules: live.rules,
        rulesHash: live.rulesHash,
        databaseRules: live.databaseRules,
        databaseRulesHash: live.databaseRulesHash,
        databaseUrl: live.databaseUrl,
        storageRules: live.storageRules,
        storageRulesHash: live.storageRulesHash,
        // Project identity: scopes the storage IDB name per served project
        // (issue #359). Local-only — a dev path never leaves the machine.
        projectKey: cwd,
        // The bound port is known only after `listen`; initPayload runs per
        // request (after listen), so resolve it lazily here. Absolute ws://host:port
        // mirrors serve (the browser reads this as the bridge peer URL).
        bridgeUrl: (() => {
          if (!mount) return null;
          const addr = server.httpServer?.address();
          const port = addr && typeof addr === 'object' ? addr.port : 0;
          const host = (typeof server.config.server.host === 'string' && server.config.server.host) || 'localhost';
          return port > 0 ? mount.wsUrl({ host, port }) : null;
        })(),
        // Precedence: once a state file exists, lived state is the truth — seed
        // applies only on the first (state-less) run.
        seed: state?.exists() ? null : seed,
        seedState,
        persist: Boolean(state),
        capture: Boolean(capture),
        authUsers: state
          ? ((state.readSection('auth') as { users?: Record<string, unknown>[] } | null)?.users ?? null)
          : seedUsers,
        // Messaging is part of the canonical firebase/* sandbox swap.
        messaging: true,
        // Plugin-level engine → the worker host's ctx.aiEngine (host-ai.ts),
        // which wins over any op-carried engine. Null when unset.
        ai: resolvedAi.engineWire ? { engine: resolvedAi.engineWire } : null,
      });
      // Pyric Studio: mount the disk-backed workspace/project routes that
      // Studio's `local` mode talks to + serve the built Studio app at
      // /__pyric/ui/. Mirrors `pyric dev --ui`; the unified Astro site is
      // vendored in this package's dist (resolveSiteUiDir).
      //
      // ON BY DEFAULT, including under `bridge`: the bridge now routes agent
      // tool-calls THROUGH the SharedWorker (see `connectBridgePeer`), so the
      // app, Studio, and agent all observe the ONE sandbox. Explicit `ui: false`
      // still wins.
      const uiEnabled = options.ui ?? true;
      const studio = uiEnabled
        ? {
            workspace: diskWorkspace(cwd),
            projects: diskProjectStore(path.join(cwd, '.pyric', 'projects')),
          }
        : undefined;
      let siteUiDir: string | undefined;
      if (uiEnabled) {
        siteUiDir = resolveSiteUiDir() ?? undefined;
        if (!siteUiDir) {
          server.config.logger.warn(
            '[pyric] ui: built Astro site not found; /__pyric/ui/ will 404 ' +
              '(run the full build, or reinstall @pyric/cli).',
          );
        }
      }
      const { sdkDir, epoch: workerVersion } = workerRuntime.status();
      const namespace = createPyricNamespace({
        sdkDir,
        initPayload,
        events,
        activity: (incident) => server.config.logger.warn(formatActivityWarning(incident)),
        state,
        capture,
        studio,
        siteUiDir,
        workerVersion: workerVersion ?? undefined,
        // `ai.proxyUpstream`: what `/__pyric/ai-proxy` forwards to (beats the
        // PYRIC_AI_PROXY_UPSTREAM env var; falls back to the default when unset).
        aiProxyUpstream: resolvedAi.proxyUpstream,
        // Adapt Vite's logger to the plain info/note shape the namespace's
        // diagnostics (denial relay, future hot-reload lines) expect —
        // matches the `↻`/`⚠ [pyric]` lines already logged elsewhere in this
        // plugin via `server.config.logger` directly.
        logger: {
          info: (m) => server.config.logger.info(m),
          note: (m) => server.config.logger.warn(m),
        },
      });

      // DNS-rebinding guard for the /__pyric/* surface. Vite has its own host
      // check, but a `configureServer` hook that doesn't return a function mounts
      // BEFORE it (and the ordering differs across Vite 5/6/7), so guard here too
      // — independent of Vite's internals. Reuses serve's `isAllowedHost`.
      const srvOpts = server.config.server;
      const hostAllowed = (req: IncomingMessage): boolean => {
        if (srvOpts.allowedHosts === true) return true; // user opted into all hosts
        const boundHost = typeof srvOpts.host === 'string' ? srvOpts.host : 'localhost';
        const extra = Array.isArray(srvOpts.allowedHosts) ? srvOpts.allowedHosts : [];
        return isAllowedHost(req.headers.host, boundHost, extra);
      };

      // Connect-middleware adapter (build `url` from originalUrl; next() when the
      // namespace closure returns false; never rewrite route bodies).
      server.middlewares.use('/__pyric', (req: IncomingMessage & { originalUrl?: string }, res: ServerResponse, next: () => void) => {
        if (!hostAllowed(req)) {
          res.statusCode = 403;
          res.end(`pyric: refused request for Host '${req.headers.host ?? ''}' (DNS-rebinding guard).`);
          return;
        }
        const url = new URL(req.originalUrl ?? req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        // Bridge first (mirrors serve.ts): /__pyric/mcp + /__pyric/health must be
        // handled by the mount, not 404 through the namespace. Falls through to the
        // namespace when the mount returns false (every non-bridge route).
        Promise.resolve(mount ? mount.handler(req, res, url) : false)
          .then((bridged) => (bridged ? true : Promise.resolve(namespace(req, res, url))))
          .then((handled) => {
            if (!handled) next();
          })
          .catch((err: unknown) => {
            if (!res.headersSent) res.statusCode = 500;
            res.end(err instanceof Error ? err.message : String(err));
          });
      });

      // WS upgrade for the in-page sandbox peer (ws://…/__pyric/sandbox). The
      // listener only fires once upgrades arrive (after listen), so adding it in
      // configureServer is safe. middlewareMode has no httpServer → HTTP bridge
      // routes still work, just no WS peer.
      // Cast: Vite types `httpServer` as http.Server | http2.Http2SecureServer;
      // attachUpgrade only needs `.on('upgrade')`, present on both. (serve passes
      // a plain http.Server, so this widening is plugin-specific.)
      if (mount && server.httpServer) mount.attachUpgrade(server.httpServer as unknown as HttpServer);

      // A2 discovery pointer: the stdio `mcp-proxy` (the sanctioned Claude Code
      // entrypoint) reads `.pyric/serve.json` to find the bridge without a fixed
      // URL -- it takes the PORT and probes BOTH loopback families, defeating the
      // IPv6/IPv4 trap that broke the hand-written `.mcp.json`. serve writes this
      // pointer; the Vite plugin must too. Written after listen (port known),
      // removed on close.
      if (mount && server.httpServer) {
        const httpServer = server.httpServer;
        const pointer = path.join(cwd, '.pyric', 'serve.json');
        const host =
          (typeof server.config.server.host === 'string' && server.config.server.host) || 'localhost';
        const writePointer = (): void => {
          const addr = httpServer.address();
          const port = addr && typeof addr === 'object' ? addr.port : 0;
          if (!port) return;
          try {
            mkdirSync(path.dirname(pointer), { recursive: true });
            writeFileSync(
              pointer,
              JSON.stringify(
                {
                  url: `http://${host}:${port}`,
                  mcpUrl: mount.mcpUrl({ host, port }),
                  port,
                  pid: process.pid,
                  instanceId: mount.instanceId,
                  project: bridgeOpts?.project ?? 'sandbox',
                },
                null,
                2,
              ) + '\n',
            );
          } catch {
            /* best-effort: the proxy falls back to a port scan */
          }
        };
        // Cross-family collision guard: once listening, probe BOTH loopback
        // families on our port. If a DIFFERENT sandbox answers on the other
        // family, two dev servers are colliding (IPv4 `*:P` + IPv6 `[::1]:P`)
        // and the agent/browser can split across them (writes seem to vanish).
        // #697's dual-bind can't apply here — Vite owns the single listen — so
        // we can only warn, loudly. (Our own family answers with our instanceId
        // and is skipped; a dual-stack bind owns both and never trips this.)
        const warnOnCollision = async (): Promise<void> => {
          const a = httpServer.address();
          const p = a && typeof a === 'object' ? a.port : 0;
          if (!p) return;
          for (const probe of [`http://127.0.0.1:${p}`, `http://[::1]:${p}`]) {
            try {
              const res = await fetch(`${probe}/__pyric/health`, { signal: AbortSignal.timeout(1000) });
              if (res.status !== 200) continue;
              const body = (await res.json()) as { mode?: string; instanceId?: string };
              if (body.mode === 'sandbox' && body.instanceId && body.instanceId !== mount.instanceId) {
                server.config.logger.warn(
                  `\n⚠  pyric: another sandbox already serves port ${p} on a different loopback ` +
                    `family (${probe}). Two dev servers are colliding across IPv4/IPv6 — your MCP ` +
                    `agent and browser can land on DIFFERENT sandboxes (writes seem to vanish). ` +
                    `Stop the other server, or give this app a unique \`server.port\` so the two ` +
                    `don't share one (pinning server.host to a family the squatter holds would ` +
                    `just EADDRINUSE).\n`,
                  { timestamp: true },
                );
                return; // one warning is enough
              }
            } catch {
              /* other family silent — no collision */
            }
          }
        };
        const announce = (): void => {
          writePointer();
          void warnOnCollision();
        };
        if ((httpServer as unknown as { listening?: boolean }).listening) announce();
        else httpServer.once('listening', announce);
        httpServer.once('close', () => {
          try {
            rmSync(pointer);
          } catch {
            /* gone already */
          }
        });
      }

      // ── Functions child lifecycle (mirrors serve's runServe) ─────────────
      // The Functions runtime executes in an isolated node child (child.ts),
      // exactly as `pyric dev` runs it: the child loads the user's unchanged
      // functions module, and `--import @pyric/cli/register` + `PYRIC_SANDBOX=
      // remote:<serveUrl>` route its `firebase-admin/app` to a RemoteSandbox that
      // dials the bridge WS (`/__pyric/sandbox`). onValueCreated triggers observe
      // RTDB writes and write their effects back through that one shared sandbox.
      // Started once a sandbox peer (a browser tab / SharedWorker relay) has
      // connected — the trigger's baseline needs a live backend — and stopped on
      // server close. Vite restarts re-run configureServer, so the child respawns
      // with the new server. Unlike `pyric dev` (which does not watch functions
      // source), the plugin hot-reloads it via Vite's own watcher — see the
      // watch block below; `functions: { watch: false }` restores dev's
      // restart-to-reload behavior.
      if (functionsProject && functionsProjectId && mount && server.httpServer) {
        const httpServer = server.httpServer;
        const project = functionsProject;
        const projectId = functionsProjectId;
        const bridgeMount = mount;
        const host =
          (typeof server.config.server.host === 'string' && server.config.server.host) || 'localhost';
        // Prefer the compiled child (node cannot execute the .ts source when the
        // plugin runs from source in tests); fall back to spawnFunctionsRtdbChild's
        // own default (correct when the plugin runs from dist in production).
        const builtChild = path.join(cliRoot, 'dist/functions-rtdb/child.js');
        const childModuleUrl = existsSync(builtChild) ? builtChild : undefined;
        let functionsChild: FunctionsRtdbChildHandle | null = null;
        let disposed = false;

        const start = async (mode: 'initial' | 'reload' = 'initial'): Promise<void> => {
          const addr = httpServer.address();
          const port = addr && typeof addr === 'object' ? addr.port : 0;
          if (!port || disposed) return;
          const serveUrl = `http://${host}:${port}`;

          // Wait (bounded) for a sandbox peer — the SharedWorker relay / browser
          // tab that holds the backend. Poll the mount directly (no self-fetch).
          // On a hot reload the peer is usually still connected (the loop exits
          // immediately); when it dropped mid-session, wait briefly rather than
          // the full initial 30s.
          const deadline = Date.now() + (mode === 'reload' ? 5_000 : 30_000);
          while (!disposed && !bridgeMount.sandboxConnected()) {
            if (Date.now() >= deadline) break;
            await new Promise((r) => setTimeout(r, 250));
          }
          if (disposed) return;
          if (!bridgeMount.sandboxConnected()) {
            server.config.logger.warn(
              mode === 'reload'
                ? `  ✖ [pyric] functions not restarted — no sandbox peer connected. ` +
                    `Functions stay down until the next save with ${serveUrl} open.`
                : `  ⚠ [pyric] functions not started — no browser tab connected after 30s. ` +
                    `Open ${serveUrl} and restart the dev server.`,
            );
            return;
          }

          functionsChild = spawnFunctionsRtdbChild({
            cwd: project.sourceDir,
            entry: project.entry,
            env: buildChildEnv(process.env, { serveUrl, registerUrl: registerModuleUrl() }),
            // Precedence (per field): plugin option > env var > firebase files
            // > default. projectId already folds PYRIC_PROJECT > .firebaserc >
            // demo-project.
            instance: functionsOpts.instance ?? `${projectId}-default-rtdb`,
            location: functionsOpts.region ?? process.env.PYRIC_FUNCTIONS_RTDB_REGION ?? 'us-central1',
            ...(childModuleUrl ? { childModuleUrl } : {}),
            onEvent(event) {
              if (event.type === 'execution') {
                const params = Object.entries(event.params)
                  .map(([name, value]) => `${name}=${value}`)
                  .join(', ');
                const suffix = params ? ` (${params})` : '';
                if (event.status === 'fulfilled') {
                  server.config.logger.info(`  ✔ [pyric] function ${event.exportName} ← /${event.ref}${suffix}`);
                } else {
                  server.config.logger.error(
                    `  ✖ [pyric] function ${event.exportName} ← /${event.ref}${suffix}: ${event.error.message}`,
                  );
                }
              } else {
                server.config.logger.error(
                  `  ✖ [pyric] functions delivery for ${event.exportName}: ${event.error.message}`,
                );
              }
            },
          });

          const out = createLinePrefixer('[functions] ', (line) => server.config.logger.info(line.replace(/\n$/, '')));
          const err = createLinePrefixer('[functions] ', (line) => server.config.logger.warn(line.replace(/\n$/, '')));
          functionsChild.child.stdout?.setEncoding('utf8');
          functionsChild.child.stderr?.setEncoding('utf8');
          functionsChild.child.stdout?.on('data', (chunk: string) => out.push(chunk));
          functionsChild.child.stderr?.on('data', (chunk: string) => err.push(chunk));
          functionsChild.child.stdout?.once('end', () => out.flush());
          functionsChild.child.stderr?.once('end', () => err.flush());

          try {
            const ready = await functionsChild.ready;
            server.config.logger.info(
              mode === 'reload'
                ? `  ↻ [pyric] functions reloaded (${ready.triggerCount} trigger${ready.triggerCount === 1 ? '' : 's'})`
                : `  ✔ [pyric] functions ${ready.triggerCount} onValueCreated ` +
                    `trigger${ready.triggerCount === 1 ? '' : 's'} from ${path.relative(cwd, project.entry)}`,
            );
            for (const unsupported of ready.unsupportedTriggers) {
              server.config.logger.warn(
                `  ⚠ [pyric] functions export ${unsupported.exportName} uses unsupported trigger ` +
                  `${unsupported.eventType}; it will not run.`,
              );
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            server.config.logger.error(
              mode === 'reload'
                ? // Unlike rules, last-good cannot stay live — the old child is
                  // already stopped — so a broken save takes functions down.
                  `  ✖ [pyric] functions failed to reload: ${message}\n` +
                    `  ✖ [pyric] functions are down until the next good save.`
                : `  ✖ [pyric] functions failed to start: ${message}`,
            );
            await functionsChild.stop().catch(() => undefined);
            functionsChild = null;
          }
        };

        let reloadDebounce: ReturnType<typeof setTimeout> | null = null;
        httpServer.once('close', () => {
          disposed = true;
          if (reloadDebounce) clearTimeout(reloadDebounce);
          void functionsChild?.stop().catch(() => undefined);
        });
        if ((httpServer as unknown as { listening?: boolean }).listening) void start();
        else httpServer.once('listening', () => void start());

        // Functions hot-reload from Vite's OWN watcher (mirrors the rules block
        // below). Restart = redeploy: stop the old child, respawn via the same
        // start path — there is no in-place swap, so in-flight executions in the
        // old child may drop and writes landing in the swap gap become the new
        // child's baseline (execution.ts consumes each trigger's first observed
        // value as baseline; they do not fire). Debounced 300ms — a save fans
        // out several fs events and a child respawn is far heavier than a rules
        // re-parse. Restarts are serialized: a save landing mid-restart queues
        // exactly one follow-up run.
        if (functionsOpts.watch !== false) {
          const sourceDir = project.sourceDir;
          // Usually redundant (Vite watches its root, which contains the
          // functions dir in the common layout) but load-bearing when the
          // functions source lives outside Vite's root. node_modules stays
          // ignored: Vite's watcher ignores `**/node_modules/**` globally, and
          // the handler below filters it again for explicitly-added trees.
          server.watcher.add(sourceDir);
          let restarting = false;
          let queued = false;
          const restart = async (): Promise<void> => {
            if (restarting) {
              queued = true;
              return;
            }
            restarting = true;
            try {
              do {
                queued = false;
                if (disposed) return;
                const old = functionsChild;
                functionsChild = null;
                if (old) await old.stop().catch(() => undefined);
                await start('reload');
              } while (queued && !disposed);
            } finally {
              restarting = false;
            }
          };
          const onFunctionsFsEvent = (file: string): void => {
            const resolved = path.resolve(file);
            const rel = path.relative(sourceDir, resolved);
            if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return;
            if (rel.split(path.sep).includes('node_modules')) return;
            if (reloadDebounce) clearTimeout(reloadDebounce);
            reloadDebounce = setTimeout(() => void restart(), 300);
          };
          server.watcher.on('change', onFunctionsFsEvent);
          server.watcher.on('add', onFunctionsFsEvent);
          server.watcher.on('unlink', onFunctionsFsEvent);
        }
      }

      // Rules hot-reload from Vite's OWN watcher (no second fs watcher). Reuse
      // prepareRulesSource (resolve + lint); last-good stays live on a broken save.
      // Debounced (editors emit several change events per save) — matches
      // watchProjectRules' 150ms cadence, which we can't reuse here (it opens its
      // own fs watcher).
      if (loaded.sourcePath) {
        const rulesFile = loaded.sourcePath;
        let debounce: ReturnType<typeof setTimeout> | null = null;
        server.watcher.add(rulesFile);
        server.watcher.on('change', (file) => {
          if (path.resolve(file) !== path.resolve(rulesFile)) return;
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => {
          void readFile(rulesFile, 'utf8').then(
            (raw) => {
              try {
                const rules = prepareRulesSource(raw, rulesFile);
                live.rules = rules;
                live.rulesHash = rulesHashOf(rules);
                events.broadcast('rules-changed', { rules, rulesHash: live.rulesHash });
                server.config.logger.info(`  ↻ [pyric] rules reloaded (${live.rulesHash})`);
              } catch (e) {
                server.config.logger.warn(
                  `  ⚠ [pyric] rules NOT reloaded (last-good stays live): ${e instanceof Error ? e.message : String(e)}`,
                );
              }
            },
            () => {},
          );
          }, 150);
        });
      }
    },

    // Sandbox build only: emit the serve init entry as its own chunk. Emitted in
    // buildStart (module graph time); its final filename is resolved in
    // generateBundle. Our plugin is `enforce: 'pre'`, so our generateBundle runs
    // BEFORE Vite's build-html plugin applies transformIndexHtml — the filename
    // is always available when the script tag is injected below.
    buildStart() {
      if (sandboxBuild) {
        initChunkRef = this.emitFile({
          type: 'chunk',
          id: entries.init,
          name: 'pyric-sandbox-init',
        });
      }
    },
    generateBundle() {
      if (initChunkRef) initChunkFile = this.getFileName(initChunkRef);
    },

    transformIndexHtml(html) {
      const runtimeChipTag = `<meta name="${PYRIC_RUNTIME_CHIP_META}" content="${runtimeChipMetaValue(options.runtimeChip)}" data-studio="${options.ui === false ? 'off' : 'on'}" data-pyric-sandbox>`;
      // Sandbox BUILD: the app's own `firebase/*` imports were already swapped
      // (resolveId, above) to pyric's in-page adapters and BUNDLED into the app
      // chunk, and the emitted init chunk (script-tagged here) carries the
      // runtime bootstrap + the ServeAuthHelper popup picker — rollup shares
      // ONE runtime module between the two, so the output is fully
      // self-contained. `pyric dev` sees the marker below and skips its own
      // serve-time injection for this page (a second injected runtime would
      // double-init: two banners, two bridge peers). The marker is also the
      // signal that makes `pyric dev` trust this dist (skip the inlined-SDK
      // scan). transformIndexHtml runs BEFORE Vite writes index.html, so both
      // land in the emitted asset.
      if (sandboxBuild) {
        if (html.includes(SANDBOX_BUILD_META)) return html;
        const initTag = initChunkFile
          ? `<script type="module" crossorigin src="/${initChunkFile}" data-pyric-sandbox-init></script>`
          : '';
        const tags = SANDBOX_BUILD_META + runtimeChipTag + initTag;
        return html.includes('</head>')
          ? html.replace('</head>', `${tags}</head>`)
          : tags + html;
      }
      const MARKER = 'data-pyric-sandbox';
      if (html.includes(MARKER)) return html;
      // Worker path (default): stamp the served worker's content hash so the page
      // can WARN when a still-running OLD worker is stale (a SharedWorker can't
      // hot-update). In-page path: force it via the explicit flag before the init
      // module evaluates — a classic inline script runs before the deferred module.
      // The flag (not nulling `window.SharedWorker`) leaves the user's own
      // SharedWorker usage intact. We force in-page ONLY when the worker bundle
      // failed (worker runtime unready) — the ephemeral fallback. `bridge` no longer
      // forces in-page: the bridge peer routes agent tool-calls THROUGH the
      // worker (see `connectBridgePeer`), so the agent shares the one sandbox the
      // app + Studio use.
      const head = workerRuntime.headTag(MARKER);
      // Plugin-level engine for the IN-PAGE path: a classic inline script runs
      // before the deferred init module AND before app code's `getAI`, so the
      // served `getAI` (entries/ai.ts) reads it synchronously — init.json can't
      // be awaited there. Harmless on the worker path (that branch ignores the
      // global; the worker reads ctx.aiEngine from init.json). `<` is escaped so
      // an engine value can never break out of the script tag.
      const aiEngineTag = resolvedAi.engineWire
        ? `<script ${MARKER}>globalThis.__PYRIC_AI_ENGINE__=${JSON.stringify(resolvedAi.engineWire).replace(/</g, '\\u003c')};</script>`
        : '';
      // Boot the sandbox by loading the real init entry as a module (Vite
      // serves + transforms it). The init module's top-level await deploys rules
      // before app code runs. Mirrors serve's injectServeTags.
      const tag = head + aiEngineTag + runtimeChipTag + `<script type="module" src="/@fs/${entries.init}" ${MARKER}></script>`;
      return html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : tag + html;
    },
  };
}
