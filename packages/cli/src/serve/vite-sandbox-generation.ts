import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
import path from 'node:path';
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
import { isAllowedHost } from './server.js';
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

    const functionsOptions = typeof options.functions === 'object' ? options.functions : {};
    const functionsProject = options.functions === false
      ? null
      : dependencies.discoverFunctionsProject(cwd);
    const functionsProjectId = functionsProject
      ? (process.env.PYRIC_PROJECT ?? (await dependencies.readFirebaseRc(cwd))?.projects?.default ?? 'demo-project')
      : null;
    const serverOptions = server.config.server;
    bridge = options.bridge || functionsProject
      ? dependencies.createBridge({
          ...(options.bridge ?? {}),
          project: options.bridge?.project ?? functionsProjectId ?? undefined,
          upgradeGuard: {
            boundHost: typeof serverOptions.host === 'string' ? serverOptions.host : 'localhost',
            allowedHosts:
              serverOptions.allowedHosts === true
                ? true
                : Array.isArray(serverOptions.allowedHosts)
                  ? serverOptions.allowedHosts
                  : [],
          },
        })
      : null;

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

    const hostAllowed = (req: IncomingMessage): boolean => {
      if (serverOptions.allowedHosts === true) return true;
      const boundHost = typeof serverOptions.host === 'string' ? serverOptions.host : 'localhost';
      const extra = Array.isArray(serverOptions.allowedHosts) ? serverOptions.allowedHosts : [];
      return isAllowedHost(req.headers.host, boundHost, extra);
    };
    let middlewareActive = true;
    listenerDisposers.push(() => { middlewareActive = false; });
    server.middlewares.use(
      '/__pyric',
      (req: IncomingMessage & { originalUrl?: string }, res: ServerResponse, next: () => void) => {
        if (!middlewareActive) {
          next();
          return;
        }
        if (!hostAllowed(req)) {
          res.statusCode = 403;
          res.end(`pyric: refused request for Host '${req.headers.host ?? ''}' (DNS-rebinding guard).`);
          return;
        }
        const url = new URL(
          req.originalUrl ?? req.url ?? '/',
          `http://${req.headers.host ?? 'localhost'}`,
        );
        Promise.resolve(bridge ? bridge.handler(req, res, url) : false)
          .then((bridged) => (bridged ? true : Promise.resolve(session!.handle(req, res, url))))
          .then((handled) => {
            if (!handled) next();
          })
          .catch((error: unknown) => {
            if (!res.headersSent) res.statusCode = 500;
            res.end(error instanceof Error ? error.message : String(error));
          });
      },
    );

    if (bridge && server.httpServer) {
      const httpServer = server.httpServer as unknown as HttpServer;
      const host = (typeof serverOptions.host === 'string' && serverOptions.host) || 'localhost';
      bridgeAttachment = bridge.attachHost({
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
    }

    if (functionsProject && functionsProjectId && bridge && server.httpServer) {
      const host = (typeof serverOptions.host === 'string' && serverOptions.host) || 'localhost';
      const builtChild = path.join(cliRoot, 'dist/functions-rtdb/child.js');
      const childModuleUrl = dependencies.fileExists(builtChild) ? builtChild : undefined;
      functionsAttachment = dependencies.attachFunctions({
        cwd,
        project: functionsProject,
        projectId: functionsProjectId,
        instance: functionsOptions.instance,
        region: functionsOptions.region,
        watch: functionsOptions.watch,
        host,
        httpServer: server.httpServer as unknown as HttpServer,
        watcher: server.watcher,
        logger: server.config.logger,
        bridge,
        baseEnv: process.env,
        registerUrl: dependencies.registerModuleUrl(),
        ...(childModuleUrl ? { childModuleUrl } : {}),
      });
    }

    const rulesFile = session.summary.rules.firestore.sourcePath;
    if (rulesFile) {
      let debounce: ReturnType<typeof setTimeout> | null = null;
      server.watcher.add(rulesFile);
      const onRulesChange = (file: string): void => {
        if (path.resolve(file) !== path.resolve(rulesFile)) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          void session!.reloadFirestoreRules().then((result) => {
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
      listenerDisposers.push(() => {
        if (debounce) clearTimeout(debounce);
        server.watcher.off('change', onRulesChange);
      });
    }

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
