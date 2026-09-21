import type { FlowConfig } from './flow-config.js';
import { existsSync } from 'node:fs';
import type { ViteDevServer } from 'vite';
import { readFirebaseJson, readFirebaseRc, type FirebaseJson } from '../cli/firebase-json.js';
import { registerModuleUrl } from '../cli/sandbox-runner.js';
import {
  discoverFunctionsRtdbProject,
  type FunctionsRtdbProject,
} from '../functions-rtdb/project.js';
import { formatActivityWarning } from './activity-warning.js';
import { formatAiStatusNote } from './ai-status.js';
import {
  createBridgeMount,
  type BridgeHostAttachment,
  type BridgeMount,
  type BridgeMountOptions,
} from './bridge-mount.js';
import { resolveSiteUiDir } from './bundler.js';
import {
  createSandboxSession,
  SandboxSeedError,
  type SandboxSession,
  type SandboxSessionOptions,
} from './sandbox-session.js';
import {
  attachViteFunctionsDevelopment,
  type ViteFunctionsDevelopmentAttachment,
  type ViteFunctionsDevelopmentOptions,
} from './vite-functions-development.js';
import type { ResolvedViteAiConfig } from './vite-ai-config.js';
import { resolveAvatarsConfig, type PyricAvatarsOptions } from './avatars-config.js';
import { resolveViteRulesConfig } from './vite-rules-source.js';
import type { ViteWorkerRuntime, ViteWorkerRuntimeStatus } from './vite-worker-runtime.js';
import { viteWorkerEpochSalt } from './vite-ai-config.js';
import {
  attachViteGenerationBridge,
  createViteGenerationBridge,
} from './vite-generation-bridge.js';
import {
  attachViteGenerationFunctions,
  resolveViteGenerationFunctions,
} from './vite-generation-functions.js';
import { attachViteGenerationMiddleware } from './vite-generation-middleware.js';
import { watchViteGenerationRules } from './vite-generation-rules-watch.js';
import { claimProjectState } from './hosted/project-ownership.js';

export interface ViteSandboxGenerationOptions {
  hosted?: boolean;
  flow?: FlowConfig;
  rules: string | undefined;
  seed: string | undefined;
  persist: boolean | undefined;
  fresh: boolean | undefined;
  capture: boolean | undefined;
  bridge: Omit<BridgeMountOptions, 'upgradeGuard'> | null;
  ui: boolean;
  functions: false | { region?: string; instance?: string; watch?: boolean };
  avatars: PyricAvatarsOptions | undefined;
}

export interface ViteSandboxGenerationInput {
  server: ViteDevServer;
  projectDir: string;
  cliRoot: string;
  workerRuntime: ViteWorkerRuntime;
  options: ViteSandboxGenerationOptions;
  ai: ResolvedViteAiConfig;
}

export interface ViteSandboxGeneration {
  close(): Promise<void>;
}

/** Internal adapters used to force lifecycle failures through the module interface. */
export interface ViteSandboxGenerationDependencies {
  readFirebaseJson: typeof readFirebaseJson;
  readFirebaseRc: typeof readFirebaseRc;
  resolveRulesConfig: typeof resolveViteRulesConfig;
  resolveAvatarsConfig: typeof resolveAvatarsConfig;
  prepareWorker(runtime: ViteWorkerRuntime, epochSalt: string): Promise<void>;
  workerStatus(runtime: ViteWorkerRuntime): ViteWorkerRuntimeStatus;
  discoverFunctionsProject(cwd: string): FunctionsRtdbProject | null;
  resolveSiteUiDir: typeof resolveSiteUiDir;
  createBridge(options: BridgeMountOptions): BridgeMount;
  createSession(options: SandboxSessionOptions): Promise<SandboxSession>;
  attachFunctions(options: ViteFunctionsDevelopmentOptions): ViteFunctionsDevelopmentAttachment;
  registerModuleUrl: typeof registerModuleUrl;
  fileExists(path: string): boolean;
}

const DEFAULT_DEPENDENCIES: ViteSandboxGenerationDependencies = {
  readFirebaseJson,
  readFirebaseRc,
  resolveRulesConfig: resolveViteRulesConfig,
  resolveAvatarsConfig,
  prepareWorker: (runtime, epochSalt) => runtime.prepare(epochSalt),
  workerStatus: (runtime) => runtime.status(),
  discoverFunctionsProject: discoverFunctionsRtdbProject,
  resolveSiteUiDir,
  createBridge: createBridgeMount,
  createSession: createSandboxSession,
  attachFunctions: attachViteFunctionsDevelopment,
  registerModuleUrl,
  fileExists: existsSync,
};

/**
 * Construct and own one configured generation of the Vite development sandbox.
 * The caller owns replacement; this module owns attachment, rollback, and close.
 */
export async function createViteSandboxGeneration(
  input: ViteSandboxGenerationInput,
  dependencyOverrides: Partial<ViteSandboxGenerationDependencies> = {},
): Promise<ViteSandboxGeneration> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const { server, projectDir: cwd, cliRoot, workerRuntime, options, ai } = input;
  const listenerDisposers: Array<() => void> = [];
  let session: SandboxSession | null = null;
  let bridge: BridgeMount | null = null;
  let bridgeAttachment: BridgeHostAttachment | null = null;
  let functionsAttachment: ViteFunctionsDevelopmentAttachment | null = null;
  let closePromise: Promise<void> | null = null;
  let stateOwner: Awaited<ReturnType<typeof claimProjectState>> | undefined;

  const close = (): Promise<void> => {
    const pendingClose = closePromise;
    const hasStartedClosing = pendingClose !== null;
    if (hasStartedClosing) return pendingClose;
    closePromise = (async () => {
      for (const dispose of listenerDisposers.splice(0).reverse()) dispose();
      await functionsAttachment?.close();
      await bridgeAttachment?.close();
      await bridge?.close();
      await session?.close();
      stateOwner?.close();
    })();
    return closePromise;
  };

  try {
    const usesHostedSandbox = options.hosted === true;
    const lacksHttpServer = usesHostedSandbox && !server.httpServer;
    if (lacksHttpServer) {
      throw new Error('@pyric/cli/vite: hosted requires Vite’s HTTP server; middleware mode is unsupported.');
    }
    const persistsState = options.persist === true || usesHostedSandbox;
    // A hosted generation keeps its state in `.pyric/state/hosted`; a persisting
    // browser generation writes `state.json`. Each holds only its own files.
    if (persistsState) stateOwner = await claimProjectState(cwd, usesHostedSandbox ? 'host' : 'browser-state');
    let firebaseConfig: FirebaseJson | null = null;
    try {
      firebaseConfig = await dependencies.readFirebaseJson(cwd);
    } catch {
      // firebase.json is optional for Vite development.
    }
    const rulesConfig = dependencies.resolveRulesConfig(cwd, options.rules, firebaseConfig);
    // Config-time validation (an unresolvable set directory) must fail
    // startup here, not the first `/__pyric/assets/avatar/*` request — see
    // avatars-config.ts.
    const avatarsConfig = dependencies.resolveAvatarsConfig(options.avatars, process.env, cwd);

    const usesBrowserSandbox = !usesHostedSandbox;
    if (usesBrowserSandbox) {
      try {
        const epochSalt = viteWorkerEpochSalt(cwd, ai.engineWire, ai.mode);
        await dependencies.prepareWorker(workerRuntime, epochSalt);
      } catch (error) {
        const isError = error instanceof Error;
        const message = isError ? error.message : String(error);
        server.config.logger.warn(
          `  ⚠ [pyric] SharedWorker bundle failed — using the in-page sandbox (single-tab, ephemeral): ${message}`,
        );
      }
    }

    const functionsInput = {
      projectDir: cwd,
      options: options.functions,
      discover: dependencies.discoverFunctionsProject,
      readFirebaseRc: dependencies.readFirebaseRc,
    };
    const functions = await resolveViteGenerationFunctions(functionsInput);
    const bridgeInput = {
      server,
      projectDir: cwd,
      hosted: usesHostedSandbox,
      options: options.bridge,
      functionsProject: functions.project,
      functionsProjectId: functions.projectId,
      createBridge: dependencies.createBridge,
    };
    bridge = createViteGenerationBridge(bridgeInput);
    const serverOptions = server.config.server;

    let siteUiDir: string | undefined;
    const mountsStudio = options.ui;
    if (mountsStudio) {
      siteUiDir = dependencies.resolveSiteUiDir() ?? undefined;
      const hasNoSiteUi = !siteUiDir;
      if (hasNoSiteUi) {
        server.config.logger.warn(
          '[pyric] ui: built Astro site not found; /__pyric/ui/ will return 503 ' +
            '(run the full build, or reinstall @pyric/cli).',
        );
      }
    }
    const { sdkDir, epoch: workerVersion } = dependencies.workerStatus(workerRuntime);
    const sdk = { dir: sdkDir, workerVersion: workerVersion ?? undefined };
    const persistence = persistsState ? { fresh: options.fresh } : undefined;
    const studio = mountsStudio ? { siteUiDir } : false;
    const hasAiEngine = ai.engineWire !== undefined;
    const aiOptions = hasAiEngine ? { engine: ai.engineWire } : null;
    const bridgeUrl = (): string | null => {
      const activeBridge = bridge;
      const hasNoBridge = activeBridge === null;
      if (hasNoBridge) return null;
      const address = server.httpServer?.address();
      const hasAddress = address !== undefined && address !== null;
      const hasTcpAddress = hasAddress && typeof address === 'object';
      const port = hasTcpAddress ? address.port : 0;
      const configuredHost = serverOptions.host;
      const hasHostname = typeof configuredHost === 'string' && configuredHost.length > 0;
      const host = hasHostname ? configuredHost : 'localhost';
      const hasNoListeningPort = port <= 0;
      if (hasNoListeningPort) return null;
      return activeBridge.wsUrl({ host, port });
    };
    const configuredHost = server.config.server.host;
    const hasBoundHost = typeof configuredHost === 'string';
    const boundHost = hasBoundHost ? configuredHost : 'localhost';
    const configuredAllowedHosts = server.config.server.allowedHosts;
    const hasAllowedHosts = Array.isArray(configuredAllowedHosts);
    const allowedHosts = hasAllowedHosts ? configuredAllowedHosts : [];
    const sessionOptions: SandboxSessionOptions = {
      boundHost,
      allowedHosts,
      projectDir: cwd,
      hosted: usesHostedSandbox,
      deployHostedRules: usesHostedSandbox ? bridge?.deployHostedRules : undefined,
      flow: options.flow,
      firebaseConfig: rulesConfig,
      sdk,
      seedFile: options.seed,
      persistence,
      capture: options.capture,
      studio,
      bridgeUrl,
      ai: aiOptions,
      avatars: avatarsConfig,
      aiProxyUpstream: ai.proxyUpstream,
      activity: (incident) => server.config.logger.warn(formatActivityWarning(incident)),
      logger: {
        info: (message) => server.config.logger.info(message),
        note: (message) => server.config.logger.warn(message),
      },
    };
    try {
      session = await dependencies.createSession(sessionOptions);
    } catch (error) {
      await close();
      const isSeedError = error instanceof SandboxSeedError;
      if (isSeedError) {
        const failedSeedRead = error.kind === 'read';
        if (failedSeedRead) {
          throw new Error(`@pyric/cli/vite: failed to read seed ${error.path}: ${error.detail}`);
        }
        throw new Error('@pyric/cli/vite: seed must be a JSON object of "collection/doc" → fields');
      }
      throw error;
    }

    const resetsPersistedState = persistsState && options.fresh === true;
    if (resetsPersistedState) {
      server.config.logger.info(usesHostedSandbox
        ? '  ⓘ [pyric] fresh: archived hosted state; starting a new store'
        : '  ⓘ [pyric] fresh: discarded the existing state file; re-seeding');
    }

    // Say what AI resolved to. This is the one front door where the engine and
    // its model binding ARE known at boot (`ai.engine` / `ai.model` reduced to
    // the wire shape above); the broker itself is still built lazily, in the
    // page or the worker, on the first `ai.*` op. Every generation prints it,
    // so a Vite restart on an `.env`/config edit re-announces the new binding
    // through the same formatter instead of swapping engines in silence.
    server.config.logger.info(
      formatAiStatusNote({
        hosted: usesHostedSandbox,
        engine: ai.engineWire,
        mode: ai.mode,
        proxyUpstream: ai.proxyUpstream,
      }),
    );

    if (usesHostedSandbox) {
      const baseUrl = (): string => {
        const urls = server.resolvedUrls;
        const url = urls?.local[0] ?? urls?.network[0];
        const isNotListening = url === undefined;
        if (isNotListening) throw new Error('The Vite sandbox server is not listening.');
        return url;
      };
      await bridge?.startHostedSandbox(session.payload(), baseUrl, {
        proxyUpstream: ai.proxyUpstream, logger: sessionOptions.logger,
        persistence: session.hostedPersistence,
      });
      server.config.logger.info('  ⓘ [pyric] sandbox runs in this server process (hosted)');
    }

    const middlewareInput = { server, bridge, session };
    const disposeMiddleware = attachViteGenerationMiddleware(middlewareInput);
    listenerDisposers.push(disposeMiddleware);

    const bridgeAttachmentInput = { server, projectDir: cwd, bridge };
    bridgeAttachment = attachViteGenerationBridge(bridgeAttachmentInput);

    const functionsAttachmentInput = {
      server,
      projectDir: cwd,
      cliRoot,
      bridge,
      resolved: functions,
      registerModuleUrl: dependencies.registerModuleUrl,
      fileExists: dependencies.fileExists,
      attach: dependencies.attachFunctions,
    };
    functionsAttachment = attachViteGenerationFunctions(functionsAttachmentInput);

    const rulesWatchInput = { server, session };
    const stopRulesWatch = watchViteGenerationRules(rulesWatchInput);
    const watchesRules = stopRulesWatch !== null;
    if (watchesRules) listenerDisposers.push(stopRulesWatch);

    const httpServer = server.httpServer;
    const hasHttpServer = httpServer !== undefined && httpServer !== null;
    if (hasHttpServer) {
      const onServerClose = (): void => { void close(); };
      httpServer.once('close', onServerClose);
      listenerDisposers.push(() => httpServer.removeListener('close', onServerClose));
    }

    return { close };
  } catch (error) {
    await close();
    throw error;
  }
}
