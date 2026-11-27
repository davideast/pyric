import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import path from 'node:path';
import type { ViteDevServer } from 'vite';
import type { FunctionsProject } from '../functions/project.js';
import {
  createFunctionsDevelopmentRuntime,
  createInProcessFunctionsPeerReadiness,
  type FunctionsDevelopmentEvent,
  type FunctionsDevelopmentResult,
  type FunctionsDevelopmentRuntime,
} from '../functions/development-runtime.js';
import { createFunctionsHttpGateway, type FunctionsHttpGateway } from '../functions/http/gateway.js';
import {
  createPrivateInvokerWarnings,
  functionsTriggersLine,
  httpFunctionLines,
  servedLine,
  stateAfterStart,
  unexpectedExitLine,
  UNRESPONSIVE_LINE,
  uncaughtErrorLine,
} from '../functions/http/report.js';
import type { HostingRewrite } from '../functions/http/rewrites.js';
import { formatUrlHost } from './advertised-host.js';
import type { TrustProxyPolicy } from './guard-policy.js';
import type { BridgeMount } from './bridge-mount.js';
import { watchFunctionsSourceDirectory, type FunctionsSourceWatch } from './functions-source-watch.js';

type ConnectHandler = (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void;

export interface ViteFunctionsDevelopmentOptions {
  cwd: string;
  project: FunctionsProject;
  projectId: string;
  instance?: string;
  region?: string;
  watch?: boolean;
  host: string;
  httpServer: Server;
  /** Vite's Connect stack; the Functions HTTP routes mount on it. */
  middlewares: { use(handler: ConnectHandler): unknown };
  /** The plane's DNS-rebinding guard, applied before a Functions route answers. */
  isAllowedRequest(req: IncomingMessage): boolean;
  /** firebase.json hosting rewrites, in order. */
  rewrites?: readonly HostingRewrite[];
  /** Whether a file the dev server serves answers this path; files win over rewrites. */
  staticFileExists?(pathname: string): boolean;
  /** Whether the Origin is absent or the app's own page; private functions refuse any other. */
  allowsAppOrigin(req: IncomingMessage): boolean;
  watcher: ViteDevServer['watcher'];
  logger: ViteDevServer['config']['logger'];
  bridge: BridgeMount;
  baseEnv: NodeJS.ProcessEnv;
  registerUrl: string;
  childModuleUrl?: string | URL;
  /** Optional proxy trust policy forwarded to `proxyToChild` for `x-forwarded-proto`. */
  trustProxy?: TrustProxyPolicy;
  /** Internal test seam for the host adapter; production uses the shared runtime. */
  runtimeFactory?: typeof createFunctionsDevelopmentRuntime;
}

export interface ViteFunctionsDevelopmentAttachment {
  close(): Promise<void>;
}

function reportEvent(
  logger: ViteFunctionsDevelopmentOptions['logger'],
  event: FunctionsDevelopmentEvent,
): void {
  if (event.type === 'output') {
    const line = event.line.replace(/\n$/, '');
    if (event.stream === 'stdout') logger.info(line);
    else logger.warn(line);
    return;
  }
  if (event.type === 'unexpected-exit') {
    logger.error(`  \u2716 [pyric] ${unexpectedExitLine(event.code, event.restarting !== false)}`);
    return;
  }
  if (event.type === 'starting') return;
  if (event.type === 'unresponsive') {
    logger.error(`  \u2716 [pyric] ${UNRESPONSIVE_LINE}`);
    return;
  }
  if (event.type === 'restarted') {
    if (event.result.kind === 'ready') {
      logger.info('  \u21bb [pyric] functions restarted');
    } else {
      const reason = event.result.kind === 'failed' ? event.result.error.message : 'no sandbox peer';
      logger.error(`  \u2716 [pyric] functions did not restart (${reason})`);
    }
    return;
  }
  const childEvent = event.event;
  if (childEvent.type === 'uncaught-error') {
    logger.error(`  \u2716 [pyric] ${uncaughtErrorLine(childEvent.error)}`);
    return;
  }
  if (childEvent.type === 'execution') {
    const params = Object.entries(childEvent.params)
      .map(([name, value]) => `${name}=${value}`)
      .join(', ');
    const suffix = params ? ` (${params})` : '';
    if (childEvent.status === 'fulfilled') {
      logger.info(`  \u2714 [pyric] function ${childEvent.exportName} \u2190 /${childEvent.ref}${suffix}`);
    } else {
      logger.error(
        `  \u2716 [pyric] function ${childEvent.exportName} \u2190 /${childEvent.ref}${suffix}: ${childEvent.error.message}`,
      );
    }
  } else {
    logger.error(
      `  \u2716 [pyric] functions delivery for ${childEvent.exportName}: ${childEvent.error.message}`,
    );
  }
}

function reportResult(
  options: ViteFunctionsDevelopmentOptions,
  result: FunctionsDevelopmentResult,
  mode: 'initial' | 'reload',
  serveUrl: string,
  warnPrivateInvokers: ReturnType<typeof createPrivateInvokerWarnings>,
): void {
  const { logger, project, cwd } = options;
  if (result.kind === 'no-peer') {
    if (mode === 'reload') {
      logger.warn(
        '  \u2716 [pyric] functions not restarted \u2014 no sandbox peer connected. ' +
          'Startup will retry when a sandbox peer connects, or on the next save.',
      );
    } else {
      logger.warn(
        `  \u26a0 [pyric] functions not started \u2014 no browser tab connected after 30s. ` +
          `Open ${serveUrl}; startup will retry when a sandbox peer connects.`,
      );
    }
    return;
  }
  if (result.kind === 'failed') {
    if (mode === 'reload') {
      logger.error(
        `  \u2716 [pyric] functions failed to reload: ${result.error.message}\n` +
          '  \u2716 [pyric] functions are down until the next good save.',
      );
    } else {
      logger.error(`  \u2716 [pyric] functions failed to start: ${result.error.message}`);
    }
    return;
  }
  const ready = result.ready;
  const reportsTriggers = mode === 'reload' || ready.triggerCount > 0 || ready.http === undefined;
  if (reportsTriggers) {
    const suffix = ready.triggerCount === 1 ? '' : 's';
    if (mode === 'reload') {
      logger.info(`  \u21bb [pyric] functions reloaded (${ready.triggerCount} trigger${suffix})`);
    } else {
      logger.info(`  \u2714 [pyric] ${functionsTriggersLine(ready.triggerCount, path.relative(cwd, project.entry))}`);
    }
  }
  if (ready.http) {
    const [heading, ...urls] = httpFunctionLines(ready.http, serveUrl, options.projectId);
    logger.info(`  \u2714 [pyric] ${heading}\n${urls.join('\n')}`);
    for (const warning of warnPrivateInvokers(ready.http)) logger.warn(`  \u26a0 [pyric] ${warning}`);
  }
  for (const unsupported of ready.unsupportedTriggers) {
    logger.warn(
      `  \u26a0 [pyric] functions export ${unsupported.exportName} uses unsupported trigger ` +
        `${unsupported.eventType}; it will not run.`,
    );
  }
}

/** Own the Vite-only adaptation around the host-neutral Functions runtime. */
export function attachViteFunctionsDevelopment(
  options: ViteFunctionsDevelopmentOptions,
): ViteFunctionsDevelopmentAttachment {
  const {
    httpServer,
    watcher,
    project,
    bridge,
    host,
  } = options;
  const runtimeFactory = options.runtimeFactory ?? createFunctionsDevelopmentRuntime;
  let runtime: FunctionsDevelopmentRuntime | null = null;
  let reloadDebounce: ReturnType<typeof setTimeout> | null = null;
  let reportedReload: Promise<FunctionsDevelopmentResult> | null = null;
  let closed = false;
  let running = false;
  let starting: Promise<FunctionsDevelopmentResult> | null = null;
  let reconnectQueued = false;
  let closePromise: Promise<void> | null = null;
  let crashRestartWait: { promise: Promise<void>; resolve: () => void } | null = null;
  const resolveCrashRestartWait = (): void => {
    if (crashRestartWait !== null) {
      crashRestartWait.resolve();
      crashRestartWait = null;
    }
  };
  const warnPrivateInvokers = createPrivateInvokerWarnings();
  const gatewayOptions: Parameters<typeof createFunctionsHttpGateway>[0] = {
    projectId: options.projectId,
    initial: { kind: 'starting' },
    onWarning: (warning) => options.logger.warn(`  \u26a0 [pyric] ${warning}`),
    onServed: (record) => {
      const { failed, line } = servedLine(record);
      if (failed) options.logger.error(`  \u2716 [pyric] ${line}`);
      else options.logger.info(`  \u2714 [pyric] ${line}`);
    },
    plane: 'vite',
  };
  if (options.rewrites !== undefined) {
    gatewayOptions.rewrites = options.rewrites;
  }
  if (options.staticFileExists !== undefined) {
    gatewayOptions.staticFileExists = options.staticFileExists;
  }
  if (options.trustProxy !== undefined) {
    gatewayOptions.trustProxy = options.trustProxy;
  }
  const gateway: FunctionsHttpGateway = createFunctionsHttpGateway(gatewayOptions);
  options.middlewares.use((req, res, next) => {
    if (closed || !options.isAllowedRequest(req)) {
      next();
      return;
    }
    gateway.handle(req, res, options.allowsAppOrigin).then((handled) => {
      if (!handled) next();
    }, next);
  });

  const urlHost = formatUrlHost(host);
  const serveUrl = (): string | null => {
    const address = httpServer.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    return port > 0 ? `http://${urlHost}:${port}` : null;
  };

  const retryQueued = (): void => {
    const shouldRetry = reconnectQueued && !running && !closed;
    reconnectQueued = false;
    if (shouldRetry) startFunctions();
  };
  const startFunctions = (): void => {
    const activeRuntime = runtime;
    const unavailable = activeRuntime === null || closed || running;
    if (unavailable) return;
    const transitioning = starting !== null || reportedReload !== null;
    if (transitioning) { reconnectQueued = true; return; }
    starting = activeRuntime.start();
    void starting.then(result => {
      running = result.kind === 'ready';
      const url = serveUrl() ?? `http://${urlHost}:0`;
      gateway.update(stateAfterStart(result, url));
      const shouldReport = !closed;
      if (shouldReport) reportResult(options, result, 'initial', url, warnPrivateInvokers);
    }).finally(() => { starting = null; retryQueued(); });
  };
  const releasePeerListener = bridge.onSandboxPeerConnected(startFunctions);

  const onListening = (): void => {
    const url = serveUrl();
    if (!url || closed || runtime) return;
    let functionsLocation = 'us-central1';
    if (options.region !== undefined) {
      functionsLocation = options.region;
    } else if (options.baseEnv.PYRIC_FUNCTIONS_RTDB_REGION !== undefined) {
      functionsLocation = options.baseEnv.PYRIC_FUNCTIONS_RTDB_REGION;
    }
    const runtimeOptions: Parameters<typeof createFunctionsDevelopmentRuntime>[0] = {
      sourceDir: project.sourceDir,
      entry: project.entry,
      baseEnv: options.baseEnv,
      serveUrl: url,
      registerUrl: options.registerUrl,
      hostInstanceId: bridge.instanceId,
      sessionToken: bridge.sessionToken,
      instance: options.instance ?? `${options.projectId}-default-rtdb`,
      location: functionsLocation,
      projectId: options.projectId,
      readiness: createInProcessFunctionsPeerReadiness(bridge.sandboxConnected),
      onEvent: (event) => {
        const exited = event.type === 'unexpected-exit';
        if (exited) {
          running = false;
          resolveCrashRestartWait();
          const isRestarting = event.restarting !== false;
          if (isRestarting) {
            crashRestartWait = Promise.withResolvers<void>();
            gateway.update({ kind: 'restarting', code: event.code, ready: crashRestartWait.promise });
          } else {
            gateway.update({ kind: 'exited', code: event.code });
          }
        }
        if (event.type === 'unresponsive') gateway.update({ kind: 'unresponsive' });
        if (event.type === 'restarted') {
          running = event.result.kind === 'ready';
          gateway.update(stateAfterStart(event.result, url));
          resolveCrashRestartWait();
        }
        if (event.type === 'starting' && crashRestartWait === null) {
          let nextKind: 'starting' | 'reloading' = 'starting';
          if (event.mode === 'reload') {
            nextKind = 'reloading';
          }
          gateway.update({ kind: nextKind });
        }
        reportEvent(options.logger, event);
      },
    };
    if (options.childModuleUrl !== undefined) {
      runtimeOptions.childModuleUrl = options.childModuleUrl;
    }
    runtime = runtimeFactory(runtimeOptions);
    gateway.update({ kind: 'waiting-peer', serveUrl: url });
    startFunctions();
  };

  const onFunctionsFsEvent = (file: string): void => {
    const resolved = path.resolve(file);
    const rel = path.relative(project.sourceDir, resolved);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return;
    if (rel.split(path.sep).includes('node_modules')) return;
    if (reloadDebounce) clearTimeout(reloadDebounce);
    reloadDebounce = setTimeout(() => {
      if (!runtime || closed) return;
      running = false;
      resolveCrashRestartWait();
      gateway.update({ kind: 'reloading' });
      const transition = runtime.reload();
      if (reportedReload === transition) return;
      reportedReload = transition;
      void transition.then((result) => {
        running = result.kind === 'ready';
        const url = serveUrl() ?? `http://${urlHost}:0`;
        gateway.update(stateAfterStart(result, url));
        if (!closed) reportResult(options, result, 'reload', url, warnPrivateInvokers);
      }).finally(() => {
        if (reportedReload === transition) reportedReload = null;
        retryQueued();
      });
    }, 300);
  };

  if ((httpServer as unknown as { listening?: boolean }).listening) onListening();
  else httpServer.once('listening', onListening);
  let sourceWatch: FunctionsSourceWatch | null = null;
  if (options.watch !== false) {
    watcher.add(project.sourceDir);
    watcher.on('change', onFunctionsFsEvent);
    watcher.on('add', onFunctionsFsEvent);
    watcher.on('unlink', onFunctionsFsEvent);
    sourceWatch = watchFunctionsSourceDirectory(project.sourceDir, onFunctionsFsEvent);
  }

  return {
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        closed = true;
        resolveCrashRestartWait();
        gateway.update({ kind: 'stopped' });
        releasePeerListener();
        reconnectQueued = false;
        if (reloadDebounce) clearTimeout(reloadDebounce);
        httpServer.removeListener('listening', onListening);
        sourceWatch?.close();
        sourceWatch = null;
        if (options.watch !== false) {
          watcher.off('change', onFunctionsFsEvent);
          watcher.off('add', onFunctionsFsEvent);
          watcher.off('unlink', onFunctionsFsEvent);
        }
        await runtime?.close();
      })();
      return closePromise;
    },
  };
}
