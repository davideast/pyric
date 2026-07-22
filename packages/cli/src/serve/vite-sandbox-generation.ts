import { existsSync } from 'node:fs';
import type { ViteDevServer } from 'vite';
import { readFirebaseJson, readFirebaseRc, type FirebaseJson } from '../cli/firebase-json.js';
import { registerModuleUrl } from '../cli/dev-runner.js';
import {
  discoverFunctionsRtdbProject,
  type FunctionsRtdbProject,
} from '../functions-rtdb/project.js';
import { formatActivityWarning } from './activity-warning.js';
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

export interface ViteSandboxGenerationOptions {
  rules: string | undefined;
  seed: string | undefined;
  persist: boolean | undefined;
  fresh: boolean | undefined;
  capture: boolean | undefined;
  bridge: Omit<BridgeMountOptions, 'upgradeGuard'> | null;
  ui: boolean;
  functions: false | { region?: string; instance?: string; watch?: boolean };
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

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      for (const dispose of listenerDisposers.splice(0).reverse()) dispose();
      await functionsAttachment?.close();
      await bridgeAttachment?.close();
      await bridge?.close();
      await session?.close();
    })();
    return closePromise;
  };

  try {
    let firebaseConfig: FirebaseJson | null = null;
    try {
      firebaseConfig = await dependencies.readFirebaseJson(cwd);
    } catch {
      // firebase.json is optional for Vite development.
    }
    const rulesConfig = dependencies.resolveRulesConfig(cwd, options.rules, firebaseConfig);

    try {
      await dependencies.prepareWorker(workerRuntime, viteWorkerEpochSalt(cwd, ai.engineWire));
    } catch (error) {
      server.config.logger.warn(
        `  ⚠ [pyric] SharedWorker bundle failed — using the in-page sandbox (single-tab, ephemeral): ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const functions = await resolveViteGenerationFunctions({
      projectDir: cwd,
      options: options.functions,
      discover: dependencies.discoverFunctionsProject,
      readFirebaseRc: dependencies.readFirebaseRc,
    });
    bridge = createViteGenerationBridge({
      server,
      projectDir: cwd,
      options: options.bridge,
      functionsProject: functions.project,
      functionsProjectId: functions.projectId,
      createBridge: dependencies.createBridge,
    });
    const serverOptions = server.config.server;

    let siteUiDir: string | undefined;
    if (options.ui) {
      siteUiDir = dependencies.resolveSiteUiDir() ?? undefined;
      if (!siteUiDir) {
        server.config.logger.warn(
          '[pyric] ui: built Astro site not found; /__pyric/ui/ will 404 ' +
            '(run the full build, or reinstall @pyric/cli).',
        );
      }
    }
    const { sdkDir, epoch: workerVersion } = dependencies.workerStatus(workerRuntime);
    try {
      session = await dependencies.createSession({
        projectDir: cwd,
        firebaseConfig: rulesConfig,
        sdk: { dir: sdkDir, workerVersion: workerVersion ?? undefined },
        seedFile: options.seed,
        persistence: options.persist ? { fresh: options.fresh } : undefined,
        capture: options.capture,
        studio: options.ui ? { siteUiDir } : false,
        bridgeUrl: () => {
          if (!bridge) return null;
          const address = server.httpServer?.address();
          const port = address && typeof address === 'object' ? address.port : 0;
          const host = (typeof serverOptions.host === 'string' && serverOptions.host) || 'localhost';
          return port > 0 ? bridge.wsUrl({ host, port }) : null;
        },
        ai: ai.engineWire ? { engine: ai.engineWire } : null,
        aiProxyUpstream: ai.proxyUpstream,
        activity: (incident) => server.config.logger.warn(formatActivityWarning(incident)),
        logger: {
          info: (message) => server.config.logger.info(message),
          note: (message) => server.config.logger.warn(message),
        },
      });
    } catch (error) {
      await close();
      if (error instanceof SandboxSeedError) {
        if (error.kind === 'read') {
          throw new Error(`@pyric/cli/vite: failed to read seed ${error.path}: ${error.detail}`);
        }
        throw new Error('@pyric/cli/vite: seed must be a JSON object of "collection/doc" → fields');
      }
      throw error;
    }

    if (options.persist && options.fresh) {
      server.config.logger.info('  ⓘ [pyric] fresh: discarded the existing state file; re-seeding');
    }

    listenerDisposers.push(attachViteGenerationMiddleware({ server, bridge, session }));
    bridgeAttachment = attachViteGenerationBridge({ server, projectDir: cwd, bridge });
    functionsAttachment = attachViteGenerationFunctions({
      server,
      projectDir: cwd,
      cliRoot,
      bridge,
      resolved: functions,
      registerModuleUrl: dependencies.registerModuleUrl,
      fileExists: dependencies.fileExists,
      attach: dependencies.attachFunctions,
    });
    const stopRulesWatch = watchViteGenerationRules({ server, session });
    if (stopRulesWatch) listenerDisposers.push(stopRulesWatch);

    if (server.httpServer) {
      const httpServer = server.httpServer;
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
