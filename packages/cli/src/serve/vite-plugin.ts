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
import type { Plugin, UserConfig } from 'vite';
import { createViteWorkerRuntime } from './vite-worker-runtime.js';
import type { PyricAiOptions } from './vite-ai-config.js';
import type { PyricRuntimeChipOption } from './runtime/chip-config.js';
import {
  createViteSandboxGeneration,
  type ViteSandboxGeneration,
} from './vite-sandbox-generation.js';
import { createViteModuleContext, createViteModuleSwap } from './vite-module-swap.js';
import { createVitePageRuntime } from './vite-page-runtime.js';

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

function resolveFunctionsOptions(
  options: PyricOptions['functions'],
): false | { region?: string; instance?: string; watch?: boolean } {
  if (options === false) return false;
  if (typeof options === 'object') return options;
  return {};
}

/**
 * The dev-only Vite plugin. Add to `vite.config`:
 *
 *   import { pyric } from '@pyric/cli/vite';
 *   export default defineConfig({ plugins: [pyric()] });
 */
export function pyric(options: PyricOptions = {}): Plugin {
  const moduleContext = createViteModuleContext();
  const moduleSwap = createViteModuleSwap(moduleContext);
  const { entries, cliRoot } = moduleContext;
  const workerRuntime = createViteWorkerRuntime();
  const pageRuntime = createVitePageRuntime({
    options,
    studioEnabled: options.ui !== false,
    initEntry: entries.init,
    workerRuntime,
  });

  // Normalize the public bridge shorthand once. The active generation owns the
  // bridge/session attachment and routes the peer through the SharedWorker.
  const bridgeOpts = options.bridge === true ? {} : options.bridge || null;
  let activeGeneration: ViteSandboxGeneration | null = null;

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
      return pageRuntime.applies(env);
    },
    enforce: 'pre',

    config(config, env) {
      return {
        ...moduleSwap.config(),
        ...pageRuntime.config(config, env),
      } as UserConfig;
    },

    configResolved(resolved) {
      moduleSwap.configResolved(resolved);
    },

    resolveId(source, importer) {
      return moduleSwap.resolveId(source, importer);
    },

    load(id) {
      return moduleSwap.load(id);
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
          functions: resolveFunctionsOptions(options.functions),
        },
        ai: pageRuntime.ai(),
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
      pageRuntime.buildStart((chunk) => this.emitFile(chunk));
    },
    generateBundle() {
      pageRuntime.generateBundle((referenceId) => this.getFileName(referenceId));
    },

    transformIndexHtml(html) {
      return pageRuntime.transformIndexHtml(html);
    },
  };
}
