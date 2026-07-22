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
import type { Plugin, UserConfig, ConfigEnv } from 'vite';
import type { Plugin as EsbuildPlugin } from 'esbuild';
import {
  SDK_MODULES,
  defaultSdkEntries,
  pyricPackageRoot,
  NODE_BUILTIN_RE,
  NODE_BUILTIN_SHIMS,
} from './bundler.js';
import { createViteWorkerRuntime } from './vite-worker-runtime.js';
import { SANDBOX_BUILD_META } from './sandbox-marker.js';
import {
  loadViteAiEnv,
  resolveViteAiConfig,
  viteWorkerEpochSalt,
  type PyricAiOptions,
} from './vite-ai-config.js';
import {
  PYRIC_RUNTIME_CHIP_META,
  runtimeChipMetaValue,
  type PyricRuntimeChipOption,
} from './runtime/chip-config.js';
import {
  createViteSandboxGeneration,
  type ViteSandboxGeneration,
} from './vite-sandbox-generation.js';

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

  // Normalize the public bridge shorthand once. The active generation owns the
  // bridge/session attachment and routes the peer through the SharedWorker.
  const bridgeOpts = options.bridge === true ? {} : options.bridge || null;
  let activeGeneration: ViteSandboxGeneration | null = null;

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
      const priorGeneration = activeGeneration;
      activeGeneration = null;
      await priorGeneration?.close();

      const generation = await createViteSandboxGeneration({
        server,
        projectDir: options.root ?? server.config.root,
        cliRoot,
        workerRuntime,
        options: {
          rules: options.rules,
          seed: options.seed,
          persist: options.persist,
          fresh: options.fresh,
          capture: options.capture,
          bridge: bridgeOpts,
          ui: options.ui ?? true,
          functions:
            options.functions === false
              ? false
              : typeof options.functions === 'object'
                ? options.functions
                : {},
        },
        ai: resolvedAi,
      });
      activeGeneration = generation;
    },

    async closeBundle() {
      const generation = activeGeneration;
      activeGeneration = null;
      await generation?.close();
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
