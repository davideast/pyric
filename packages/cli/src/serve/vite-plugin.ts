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
 * This is the Vite adapter over serve's proven machinery. It reuses:
 *   - the node-builtin shims — `NODE_BUILTIN_SHIMS`;
 *   - the swap targets — `defaultSdkEntries()` (the `serve/entries/*` wrappers,
 *     compiled-dist preferred, src fallback);
 *   - the host-neutral sandbox session — rules, fixtures, stores, live payload,
 *     Studio routes, `/__pyric/*` namespace, and owned cleanup;
 *   - the SharedWorker host — `bundleWorker` served at `/__pyric/sdk/worker.js`;
 *   - the bridge mount shared with `pyric dev --bridge`.
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
import { existsSync } from 'node:fs';
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
import { formatActivityWarning } from './activity-warning.js';
import {
  createBridgeMount,
  type BridgeHostAttachment,
  type BridgeMount,
} from './bridge-mount.js';
import { isAllowedHost } from './server.js';
import { SANDBOX_BUILD_META } from './sandbox-marker.js';
import { readFirebaseJson, readFirebaseRc, type FirebaseJson } from '../cli/firebase-json.js';
import {
  discoverFunctionsRtdbProject,
  type FunctionsRtdbProject,
} from '../functions-rtdb/project.js';
import { registerModuleUrl } from '../cli/dev-runner.js';
import {
  attachViteFunctionsDevelopment,
  type ViteFunctionsDevelopmentAttachment,
} from './vite-functions-development.js';
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
import {
  createSandboxSession,
  SandboxSeedError,
  type SandboxSession,
} from './sandbox-session.js';

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
  let configuredSession: SandboxSession | null = null;
  let configuredBridge: BridgeMount | null = null;
  let configuredBridgeAttachment: BridgeHostAttachment | null = null;
  let configuredFunctions: ViteFunctionsDevelopmentAttachment | null = null;
  const configuredListenerDisposers: Array<() => void> = [];

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
      const priorSession = configuredSession;
      const priorBridge = configuredBridge;
      const priorBridgeAttachment = configuredBridgeAttachment;
      const priorFunctions = configuredFunctions;
      configuredSession = null;
      configuredBridge = null;
      configuredBridgeAttachment = null;
      configuredFunctions = null;
      for (const dispose of configuredListenerDisposers.splice(0).reverse()) dispose();
      await priorFunctions?.close();
      await priorBridgeAttachment?.close();
      await priorBridge?.close();
      await priorSession?.close();
      const cwd = options.root ?? server.config.root;

      // Resolve the optional Firebase configuration before the shared session
      // loads and prepares the project's rules.
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
      let session: SandboxSession;
      try {
        session = await createSandboxSession({
          projectDir: cwd,
          firebaseConfig: config,
          sdk: { dir: sdkDir, workerVersion: workerVersion ?? undefined },
          seedFile: options.seed,
          persistence: options.persist ? { fresh: options.fresh } : undefined,
          capture: options.capture,
          studio: uiEnabled ? { siteUiDir } : false,
          bridgeUrl: () => {
            if (!mount) return null;
            const addr = server.httpServer?.address();
            const port = addr && typeof addr === 'object' ? addr.port : 0;
            const host = (typeof server.config.server.host === 'string' && server.config.server.host) || 'localhost';
            return port > 0 ? mount.wsUrl({ host, port }) : null;
          },
          ai: resolvedAi.engineWire ? { engine: resolvedAi.engineWire } : null,
          aiProxyUpstream: resolvedAi.proxyUpstream,
          activity: (incident) => server.config.logger.warn(formatActivityWarning(incident)),
          logger: {
            info: (message) => server.config.logger.info(message),
            note: (message) => server.config.logger.warn(message),
          },
        });
      } catch (error) {
        await mount?.close();
        if (error instanceof SandboxSeedError) {
          if (error.kind === 'read') {
            throw new Error(`@pyric/cli/vite: failed to read seed ${error.path}: ${error.detail}`);
          }
          throw new Error('@pyric/cli/vite: seed must be a JSON object of "collection/doc" → fields');
        }
        throw error;
      }
      let bridgeAttachment: BridgeHostAttachment | null = null;
      let functionsAttachment: ViteFunctionsDevelopmentAttachment | null = null;
      configuredSession = session;
      configuredBridge = mount;
      try {
      if (options.persist && options.fresh) {
        server.config.logger.info('  ⓘ [pyric] fresh: discarded the existing state file; re-seeding');
      }

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
          .then((bridged) => (bridged ? true : Promise.resolve(session.handle(req, res, url))))
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
      if (mount && server.httpServer) {
        const httpServer = server.httpServer as unknown as HttpServer;
        const host =
          (typeof server.config.server.host === 'string' && server.config.server.host) || 'localhost';
        bridgeAttachment = mount.attachHost({
          servers: [httpServer],
          projectDir: cwd,
          origin: () => {
            const address = httpServer.address();
            const port = address && typeof address === 'object' ? address.port : 0;
            return port > 0 ? { host, port } : null;
          },
          collision: server.config.logger,
          closeOnServerClose: false,
        });
        configuredBridgeAttachment = bridgeAttachment;
      }

      if (functionsProject && functionsProjectId && mount && server.httpServer) {
        const host =
          (typeof server.config.server.host === 'string' && server.config.server.host) || 'localhost';
        const builtChild = path.join(cliRoot, 'dist/functions-rtdb/child.js');
        const childModuleUrl = existsSync(builtChild) ? builtChild : undefined;
        functionsAttachment = attachViteFunctionsDevelopment({
            cwd,
            project: functionsProject,
            projectId: functionsProjectId,
            instance: functionsOpts.instance,
            region: functionsOpts.region,
            watch: functionsOpts.watch,
            host,
            httpServer: server.httpServer as unknown as HttpServer,
            watcher: server.watcher,
            logger: server.config.logger,
            bridge: mount,
            baseEnv: process.env,
            registerUrl: registerModuleUrl(),
            ...(childModuleUrl ? { childModuleUrl } : {}),
        });
        configuredFunctions = functionsAttachment;
      }

      // Vite owns filesystem observation; the session owns read/prepare/hash,
      // last-good replacement, live payload mutation, and SSE broadcast.
      const rulesFile = session.summary.rules.firestore.sourcePath;
      if (rulesFile) {
        let debounce: ReturnType<typeof setTimeout> | null = null;
        server.watcher.add(rulesFile);
        const onRulesChange = (file: string): void => {
          if (path.resolve(file) !== path.resolve(rulesFile)) return;
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => {
            void session.reloadFirestoreRules().then((result) => {
              if (result.kind === 'reloaded') {
                server.config.logger.info(`  ↻ [pyric] rules reloaded (${result.rulesHash})`);
              } else if (result.kind === 'rejected') {
                server.config.logger.warn(
                  `  ⚠ [pyric] rules NOT reloaded (last-good stays live): ${result.error.message}`,
                );
              }
            });
          }, 150);
        };
        server.watcher.on('change', onRulesChange);
        configuredListenerDisposers.push(() => {
          if (debounce) clearTimeout(debounce);
          server.watcher.off('change', onRulesChange);
        });
      }
      if (server.httpServer) {
        const httpServer = server.httpServer;
        const onServerClose = (): void => {
          void (async () => {
            await functionsAttachment?.close();
            await bridgeAttachment?.close();
            await mount?.close();
            await session.close();
          })();
        };
        httpServer.once('close', onServerClose);
        configuredListenerDisposers.push(() => httpServer.removeListener('close', onServerClose));
      }
      } catch (error) {
        for (const dispose of configuredListenerDisposers.splice(0).reverse()) dispose();
        if (configuredFunctions === functionsAttachment) configuredFunctions = null;
        if (configuredBridgeAttachment === bridgeAttachment) configuredBridgeAttachment = null;
        if (configuredBridge === mount) configuredBridge = null;
        if (configuredSession === session) configuredSession = null;
        await (functionsAttachment as ViteFunctionsDevelopmentAttachment | null)?.close();
        await bridgeAttachment?.close();
        await mount?.close();
        await session.close();
        throw error;
      }
    },

    async closeBundle() {
      const session = configuredSession;
      const bridge = configuredBridge;
      const bridgeAttachment = configuredBridgeAttachment;
      const functionsAttachment = configuredFunctions;
      configuredSession = null;
      configuredBridge = null;
      configuredBridgeAttachment = null;
      configuredFunctions = null;
      for (const dispose of configuredListenerDisposers.splice(0).reverse()) dispose();
      await functionsAttachment?.close();
      await bridgeAttachment?.close();
      await bridge?.close();
      await session?.close();
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
