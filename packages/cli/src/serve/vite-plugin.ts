import type { FlowConfig } from './flow-config.js';
/**
 * `@pyric/cli/vite` — the firebase->pyric-sandbox swap as a Vite plugin.
 *
 * The serve analog for SOURCE-driven apps: instead of `vite build && pyric sandbox
 * dist`, a team keeps `vite dev` (HMR, source maps) with the in-process sandbox
 * standing in for Firebase. The app's `firebase/*` imports are UNCHANGED — the
 * plugin swaps them at the module-resolution layer (`resolveId`), the same way
 * `pyric sandbox` swaps via a runtime import map. (Design: `plans/pyric-vite-plugin.md`.)
 *
 * Two flavors, one `apply` function. Under `vite dev` the swap is ALWAYS on.
 * For `vite build` the swap is MODE-gated: a plain `vite build` (mode
 * `production`) ships the real `firebase` package — the swap never reaches the
 * prod artifact — while `vite build --mode development` (any NON-production
 * mode) produces a SANDBOX build that bundles pyric's in-page adapters instead
 * of the real SDK: self-contained, meant to be previewed under `pyric sandbox`, and
 * stamped with the sandbox-build marker so it can never be deployed (`pyric
 * deploy hosting` refuses it). `pyric({ swapInBuild })` forces the build
 * behavior on/off regardless of mode. See `sandbox-marker.ts`.
 */
import type { Plugin, ResolvedConfig, UserConfig } from 'vite';
import { createViteWorkerRuntime } from './vite-worker-runtime.js';
import { findFirebaseProjectDir } from '../cli/firebase-project.js';
import { readPyricConfig } from '../cli/pyric-config.js';
import { warnDeprecatedGuardEnvOnce } from '../register/deprecated-guard-env.js';
import { resolveOwnersConfig, type OwnersConfig } from './owners-config.js';
import type { PyricAiOptions } from './vite-ai-config.js';
import type { PyricAvatarsOptions } from './avatars-config.js';
import type { PyricRuntimeChipOption } from './runtime/chip-config.js';
import {
  createViteSandboxGeneration,
  generationStateScope,
  type ViteSandboxGenerationInput,
  type ViteSandboxGenerationOptions,
} from './vite-sandbox-generation.js';
import { localGenerationSlot, projectGenerationSlot, projectSessionToken } from './vite-generation-registry.js';
import { registerProjectSessionPolicy } from './local-session-token.js';
import { attachViteHtmlSessionBootstrap, currentViteHtmlPeerContext } from './vite-generation-middleware.js';
import { createViteModuleContext, createViteModuleSwap } from './vite-module-swap.js';
import { createVitePageRuntime } from './vite-page-runtime.js';
import { stampHostedTarget } from './runtime/hosted-target.js';
import { attachLiveSdkRequestGate } from './vite-live-sdk-requests.js';
import {
  acquireViteLiveProcessStop,
  acquireViteProcessStop,
  validateViteProcessStopRuntime,
} from './vite-process-stop.js';
import { attachViteSsrActivation } from './vite-ssr-activation.js';
import { createServiceWorkerWiring, type ServiceWorkerWiringContext } from './vite-service-worker.js';
import type { SwapEnvironment, SwapResolveContext } from './vite-module-swap.js';
import type { SuppliedRows } from './vite-supplied-rows.js';
import type { PyricWriteRefusal } from './hosted/own-writes.js';
import { loadRowModulePackage } from './vite-live-package.js';
import { pyricFsDeny } from './vite-state-deny.js';
import { attachViteRealPathDeny } from './vite-real-path-deny.js';
import { attachViteProxyCheck } from './vite-proxy-check.js';

/** Vite 6's `configEnvironment` hook, which the Vite 5 `Plugin` type does not declare. */
export interface EnvironmentHooks {
  configEnvironment(name: string, config: { consumer?: string }): { resolve: { external: string[] } } | null;
}

/** The plugin context's `environment`, present from Vite 6. */
function environmentOf(context: object): SwapEnvironment | undefined {
  if (!('environment' in context)) return undefined;
  return (context as { environment?: SwapEnvironment }).environment;
}

export interface PyricOptions {
  /** Run the dev sandbox in the Vite server process, shared across browsers and
   *  Studio, with durable project state. Automatically mounts the bridge.
   *  Default: false (SharedWorker). Requires Vite's own HTTP server;
   *  middleware mode is unsupported. Does not affect production builds. */
  hosted?: boolean;
  /** Firestore rules path (relative to `root`). Default discovery prefers an
   *  authored `firestore.modules.rules`, then `firebase.json`, then
   *  `firestore.rules` in the project root. */
  rules?: string;
  /** Project dir for `firebase.json` / rules discovery. Default: Vite's `root`. */
  root?: string;
  /**
   * The Firebase project the sandbox runs as: a project id or a `.firebaserc`
   * alias. It names the default Realtime Database instance, selects the
   * `.firebaserc` deploy targets a `firebase.json` `database` array names,
   * and is the functions child's project. Without it, the project resolves as
   * the Firebase CLI resolves it: `PYRIC_PROJECT`, then the `firebase use`
   * active project for this directory, then `.firebaserc` `projects.default`.
   */
  project?: string;
  /** Persist sandbox state to `.pyric/state/state.json` so data + test users
   *  survive reloads/restarts. Off by default for SharedWorker; hosted mode
   *  always persists state. */
  persist?: boolean;
  /** With `persist` or `hosted`: discard existing state and re-seed on startup. */
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
   *  `pyric sandbox --ui` equivalent). Mounts the disk-backed workspace/project
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
  /** Overrides the shared pyric.json Flow configuration. */
  flow?: FlowConfig;
  /** Overrides the shared pyric.json `owners` configuration, field by field.
   *  `skip` lists globs for the app's data-layer wrapper modules, so a
   *  listener's owner shows the code that called the wrapper; the wrapper's
   *  frame stays on the owner's `stack`. `frames` is how many application
   *  frames each owner keeps, counted from the frame it shows (default 3). */
  owners?: OwnersConfig;
  /** RTDB-triggered Cloud Functions under this dev server (the `pyric sandbox`
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
   *    where projectId is the resolved `project` (see that option), else
   *    `demo-project`.
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
   * - `model` is the simple OpenAI-compatible path. It becomes the catch-all
   *   upstream model. `PYRIC_AI_MODEL` selects
   *   the same path when neither `model` nor `engine` is explicit.
   * - `engine` is `pyric/ai`'s `EngineConfig` (scripted | openai), applied on
   *   Node, SharedWorker, and in-page paths. An openai `baseUrl` of
   *   `/__pyric/ai-proxy` (or omitted) uses the configured upstream directly
   *   in Node; browser runtimes use the same-origin proxy to avoid CORS setup.
   * - `proxyUpstream` sets the upstream for Node and the browser proxy (beats the
   *   `PYRIC_AI_PROXY_UPSTREAM` env var; default `http://localhost:11434/v1`).
   *
   * Precedence: explicit `engine` or `model`, then `PYRIC_AI_MODEL`, then an
   * engine passed by the app's first `getAI()` call; with none, the zero-config
   * scripted default applies. `model` and `engine` are mutually exclusive.
   */
  ai?: PyricAiOptions;
  /** Profile photos for sandbox provider users. Default: deterministic
   *  generated avatars. A string selects a pre-created avatar set
   *  (directory path, resolved from the project root). `false` disables
   *  the avatar route entirely. An object supplies a custom source that
   *  runs in the dev server, never the browser. */
  avatars?: PyricAvatarsOptions;
  /** The app's own service worker module (path from the Vite root), such as a
   *  `vite-plugin-pwa` `injectManifest` source. In dev, the plugin adds a fetch
   *  listener to it that answers production Storage download URLs from the
   *  sandbox (`sandboxStorageFetch` from `pyric/storage/sw`), so the file needs
   *  no Pyric import. Builds are untouched. */
  serviceWorker?: string;
  /** Require a per-boot session capability token on every local `/__pyric/*`
   *  route, MCP, and `WS /__pyric/sandbox` (workspace, project, and AI proxy
   *  routes always require one). Default: `false` (or `pyric.json#sessionToken`). */
  sessionToken?: boolean;
}

function resolveFunctionsOptions(
  options: PyricOptions['functions'],
): false | { region?: string; instance?: string; watch?: boolean } {
  if (options === false) return false;
  if (typeof options === 'object') return options;
  return {};
}

async function readOwners(projectDir: string, overrides: OwnersConfig | undefined): Promise<OwnersConfig | undefined> {
  return resolveOwnersConfig((await readPyricConfig(projectDir)).owners, overrides);
}

/**
 * Resolves the Firebase project root directory from Vite's server root. In
 * split-directory or full-stack monorepo layouts where Vite operates inside a
 * subdirectory (e.g. `/web` or `/frontend`) while `firebase.json` or
 * `.firebaserc` resides in an ancestor workspace directory, this ascends to
 * that folder (`findFirebaseProjectDir`, which the live register shares).
 */
export function resolveFirebaseProjectDir(defaultRoot: string, explicitRoot?: string): string {
  if (explicitRoot !== undefined && explicitRoot.length > 0) {
    return explicitRoot;
  }
  return findFirebaseProjectDir(defaultRoot) ?? defaultRoot;
}

async function openSuppliedRows(supplied: SuppliedRows, resolved: ResolvedConfig): Promise<void> {
  const found = await loadRowModulePackage(resolved.root, supplied.liveRoot);
  supplied.open(found);
  const allow = resolved.server?.fs?.allow;
  if (Array.isArray(allow) && !allow.includes(found.root)) {
    allow.push(found.root);
  }
}

function ownWriteRefusalOf(supplied: SuppliedRows | undefined): PyricWriteRefusal | undefined {
  if (supplied === undefined) return undefined;
  const found = supplied.package();
  if (found === null) throw new Error('pyric: the live rows are shut, so the dev server does not start its host.');
  return found.writeRefusal;
}

/**
 * The dev-only Vite plugin. Add to `vite.config`:
 *
 *   import { pyric } from '@pyric/cli/vite';
 *   export default defineConfig({ plugins: [pyric()] });
 */
export function pyric(options: PyricOptions = {}): Plugin & EnvironmentHooks {
  return createPyricPlugin(options);
}

/**
 * The plugin, with the live rows serving pages in place of the swap
 * (`vite-supplied-rows.ts`). `pyric()` passes none; only the internal
 * `@pyric/cli/vite/internal/supplied-rows` entry passes them. They open in
 * `configResolved`, from the `@pyric/live` that supplied them or else the
 * one the project root resolves, and the dev server refuses to start without it.
 */
export function createPyricPlugin(options: PyricOptions, supplied?: SuppliedRows): Plugin & EnvironmentHooks {
  const moduleContext = createViteModuleContext();
  const { entries, cliRoot } = moduleContext;
  const workerRuntime = createViteWorkerRuntime();
  const studioEnabled = options.ui !== false;
  const pageRuntime = createVitePageRuntime({
    options,
    studioEnabled,
    initEntry: entries.init,
    workerRuntime,
  });
  const serviceWorkerWiring = createServiceWorkerWiring(options.serviceWorker);
  let serviceWorkerContext: ServiceWorkerWiringContext = { root: process.cwd(), devServer: false };
  const moduleSwap = createViteModuleSwap(moduleContext, {
    getAiMode: () => pageRuntime.ai().mode,
    supplied,
  });

  const bridgeSetting = options.bridge;
  let bridgeOpts: { project?: string; disableAuditLog?: boolean } | null = null;
  if (bridgeSetting === true) {
    bridgeOpts = {};
  } else if (bridgeSetting) {
    bridgeOpts = bridgeSetting;
  }
  const instanceSlot = localGenerationSlot();
  let releaseProcessStop: (() => void) | undefined;
  let hostedProjectKey: string | undefined;
  let hostedInstanceId: string | undefined;
  let activeSessionToken: string | undefined;
  let owners: OwnersConfig | undefined = resolveOwnersConfig(undefined, options.owners);

  function clearProcessStop(): void {
    releaseProcessStop?.();
    releaseProcessStop = undefined;
  }

  return {
    name: 'pyric:sandbox',
    apply(config, env) {
      void config;
      return pageRuntime.applies(env);
    },
    enforce: 'pre',

    config(config, env) {
      warnDeprecatedGuardEnvOnce(process.env);
      const isDevServer = env.command === 'serve' && env.isPreview !== true;
      const isSsrBuild = env.command === 'build' && (env.isSsrBuild === true || Boolean(config.build?.ssr));
      if (isDevServer) {
        validateViteProcessStopRuntime(supplied === undefined ? 'sandbox' : 'live');
      }
      serviceWorkerContext = { ...serviceWorkerContext, devServer: isDevServer };
      const moduleConfig = moduleSwap.config({
        devServer: isDevServer,
        ssrBuild: isSsrBuild,
        userConfig: config,
      });
      const pageConfig = pageRuntime.config(config, env);
      const serverConfig: UserConfig = {
        server: {
          watch: {
            ignored: ['**/.pyric/**'],
          },
          fs: {
            deny: pyricFsDeny(config),
          },
        },
      };
      return {
        ...moduleConfig,
        ...pageConfig,
        ...serverConfig,
      };
    },

    async configResolved(resolved) {
      pageRuntime.configResolved(resolved);
      moduleSwap.configResolved(resolved);
      if (supplied !== undefined) await openSuppliedRows(supplied, resolved);
      serviceWorkerContext = { ...serviceWorkerContext, root: resolved.root };
      if (resolved.command === 'build') {
        owners = await readOwners(resolveFirebaseProjectDir(resolved.root, options.root), options.owners);
      }
    },

    configEnvironment(name, environmentConfig) {
      return moduleSwap.configEnvironment(name, environmentConfig);
    },

    resolveId(source, importer, resolveOptions) {
      const context: SwapResolveContext = {
        resolve: (id, from, opts) => this.resolve(id, from, opts),
        environment: environmentOf(this),
      };
      return moduleSwap.resolvePluginId(context, source, importer, resolveOptions);
    },

    load(id) {
      return moduleSwap.loadPluginModule(id);
    },

    transform(code, id, transformOptions) {
      if (transformOptions?.ssr === true) return null;
      if (supplied === undefined) {
        const wiredServiceWorker = serviceWorkerWiring.transform(code, id, serviceWorkerContext);
        if (wiredServiceWorker !== null) return wiredServiceWorker;
      }
      if (hostedInstanceId === undefined) return null;
      const cleanId = id.split('?')[0];
      if (cleanId === entries.app || cleanId === entries['messaging-sw']) {
        return `globalThis.__PYRIC_HOST_INSTANCE_ID__=${JSON.stringify(hostedInstanceId)};\n${code}`;
      }
      return null;
    },

    async configureServer(server) {
      let unregisterProjectPolicy: (() => void) | undefined;
      clearProcessStop();
      if (supplied === undefined) {
        releaseProcessStop = acquireViteProcessStop({ getAiMode: () => pageRuntime.ai().mode });
      } else {
        releaseProcessStop = acquireViteLiveProcessStop(supplied);
      }
      try {
        const projectDir = resolveFirebaseProjectDir(server.config.root, options.root);
        const stateScope = generationStateScope(options);
        const ownsProjectState = stateScope !== null;
        const sessionToken = projectSessionToken(projectDir, {
          fresh: options.fresh === true,
        });
        activeSessionToken = sessionToken;
        const middlewareStack = (server.middlewares as { stack?: unknown[] }).stack;
        const stackBeforePyricPre = Array.isArray(middlewareStack) ? middlewareStack.length : 0;
        attachViteRealPathDeny(server, projectDir);
        attachViteHtmlSessionBootstrap(server, () => activeSessionToken);
        if (supplied !== undefined) attachLiveSdkRequestGate(server, supplied);
        if (
          Array.isArray(middlewareStack) &&
          stackBeforePyricPre > 0 &&
          middlewareStack.length > stackBeforePyricPre
        ) {
          const added = middlewareStack.splice(stackBeforePyricPre);
          middlewareStack.unshift(...added);
        }
        const slot = ownsProjectState ? projectGenerationSlot(projectDir, stateScope) : instanceSlot;
        await slot.take()?.close();
        const pyricConfig = await readPyricConfig(projectDir);
        owners = resolveOwnersConfig(pyricConfig.owners, options.owners);
        const requireSessionToken =
          supplied !== undefined ||
          options.sessionToken === true ||
          (options.sessionToken === undefined && pyricConfig.sessionToken === true);
        unregisterProjectPolicy = registerProjectSessionPolicy(projectDir, {
          token: sessionToken,
          requireSessionToken,
        });

        const uiEnabled = options.ui ?? true;
        const functionsOptions = resolveFunctionsOptions(options.functions);
        const ai = pageRuntime.ai();
        let livePassThrough: string[] | undefined;
        if (supplied !== undefined) {
          livePassThrough = [...supplied.passThrough];
        }
        const generationOptions: ViteSandboxGenerationOptions = {
          hosted: options.hosted,
          rules: options.rules,
          seed: options.seed,
          persist: options.persist,
          fresh: options.fresh,
          capture: options.capture,
          bridge: bridgeOpts,
          ui: uiEnabled,
          functions: functionsOptions,
          avatars: options.avatars,
          flow: options.flow,
          project: options.project,
          requireSessionToken,
          liveHost: supplied !== undefined,
          livePassThrough,
          liveObserved: moduleSwap.observed,
          ownWriteRefusal: ownWriteRefusalOf(supplied),
        };
        const generationInput: ViteSandboxGenerationInput = {
          server,
          projectDir,
          cliRoot,
          workerRuntime,
          options: generationOptions,
          ai,
          sessionToken,
        };
        const generation = await createViteSandboxGeneration(generationInput);
        slot.set(generation);
        const ssrActivation = attachViteSsrActivation(server, options.hosted === true);
        hostedProjectKey = options.hosted ? projectDir : undefined;
        hostedInstanceId = options.hosted ? generation.instanceId : undefined;
        const stopProxyReport = attachViteProxyCheck(server, {
          mode: supplied === undefined ? 'sandbox' : 'live',
          instanceId: generation.instanceId,
          projectId: generation.projectId,
        });
        const closeServer = server.close.bind(server);
        server.close = async () => {
          clearProcessStop();
          slot.release(generation);
          unregisterProjectPolicy?.();
          ssrActivation.close();
          stopProxyReport();
          try {
            await generation.close();
          } finally {
            await closeServer();
          }
        };
      } catch (error) {
        unregisterProjectPolicy?.();
        clearProcessStop();
        throw error;
      }
    },

    buildStart() {
      pageRuntime.buildStart((chunk) => this.emitFile(chunk));
    },
    generateBundle() {
      pageRuntime.generateBundle((referenceId) => this.getFileName(referenceId));
    },

    transformIndexHtml(html) {
      const peerContext = currentViteHtmlPeerContext();
      const stampToken = peerContext?.localPeer === true ? activeSessionToken : undefined;
      let stampProject: string | undefined;
      if (activeSessionToken === undefined || peerContext?.localPeer === true) {
        stampProject = hostedProjectKey;
      }
      return stampHostedTarget(
        pageRuntime.transformIndexHtml(html),
        stampProject,
        owners,
        hostedInstanceId,
        stampToken,
      );
    },
  };
}
