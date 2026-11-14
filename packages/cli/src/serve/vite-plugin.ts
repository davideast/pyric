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
import { acquireViteLiveProcessStop, acquireViteProcessStop } from './vite-process-stop.js';
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
   * alias.
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
  /** Seed file: a `"collection/doc" -> fields` JSON map, or a `pyric snapshot`
   *  state-file envelope. Applied at page init (state wins once it exists). */
  seed?: string;
  /** Mount the MCP bridge on Vite's dev origin so an external agent can drive
   *  this sandbox over MCP. `true` is shorthand for `{}`. */
  bridge?: boolean | { project?: string; disableAuditLog?: boolean };
  /** Serve the Pyric Studio app at `/__pyric/ui/` on Vite's dev origin.
   *  On by default; pass `ui: false` to disable. */
  ui?: boolean;
  /** Inject the collapsed Pyric runtime chip into the app during sandbox Vite
   *  dev/builds. On by default. */
  runtimeChip?: PyricRuntimeChipOption;
  /** Overrides the shared pyric.json Flow configuration. */
  flow?: FlowConfig;
  /** Overrides the shared pyric.json `owners` configuration, field by field. */
  owners?: OwnersConfig;
  /** RTDB-triggered Cloud Functions under this dev server. */
  functions?: false | { region?: string; instance?: string; watch?: boolean };
  /** Force whether `vite build` runs the firebase->pyric swap, overriding the
   *  mode default. */
  swapInBuild?: boolean;
  /** Dev-server-level AI configuration for `pyric/ai`. */
  ai?: PyricAiOptions;
  /** Profile photos for sandbox provider users. */
  avatars?: PyricAvatarsOptions;
  /** The app's own service worker module (path from the Vite root). */
  serviceWorker?: string;
  /** Require a per-boot session capability token on every local `/__pyric/*`
   *  route, MCP, and `WS /__pyric/sandbox`. */
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
 * `@pyric/cli/vite/internal/supplied-rows` entry passes them.
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
        clearProcessStop();
        if (supplied === undefined) {
          releaseProcessStop = acquireViteProcessStop({ getAiMode: () => pageRuntime.ai().mode });
        } else {
          releaseProcessStop = acquireViteLiveProcessStop(supplied);
        }
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
      try {
        pageRuntime.configResolved(resolved);
        moduleSwap.configResolved(resolved);
        if (supplied !== undefined) await openSuppliedRows(supplied, resolved);
        serviceWorkerContext = { ...serviceWorkerContext, root: resolved.root };
        if (resolved.command === 'build') {
          owners = await readOwners(resolveFirebaseProjectDir(resolved.root, options.root), options.owners);
        }
      } catch (error) {
        clearProcessStop();
        throw error;
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
      const unregisterProjectPolicy = registerProjectSessionPolicy(projectDir, {
        token: sessionToken,
        requireSessionToken,
      });

      const uiEnabled = options.ui ?? true;
      const functionsOptions = resolveFunctionsOptions(options.functions);
      const ai = pageRuntime.ai();
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
        livePassThrough: supplied === undefined ? undefined : [...supplied.passThrough],
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
      let generation: Awaited<ReturnType<typeof createViteSandboxGeneration>>;
      try {
        generation = await createViteSandboxGeneration(generationInput);
      } catch (error) {
        unregisterProjectPolicy();
        clearProcessStop();
        throw error;
      }
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
        unregisterProjectPolicy();
        ssrActivation.close();
        stopProxyReport();
        try {
          await generation.close();
        } finally {
          await closeServer();
        }
      };
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
