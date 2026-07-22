import type { Server } from 'node:http';
import path from 'node:path';
import type { ViteDevServer } from 'vite';
import type { FunctionsRtdbProject } from '../functions-rtdb/project.js';
import {
  createFunctionsDevelopmentRuntime,
  createInProcessFunctionsPeerReadiness,
  type FunctionsDevelopmentEvent,
  type FunctionsDevelopmentResult,
  type FunctionsDevelopmentRuntime,
} from '../functions-rtdb/development-runtime.js';
import type { BridgeMount } from './bridge-mount.js';

export interface ViteFunctionsDevelopmentOptions {
  cwd: string;
  project: FunctionsRtdbProject;
  projectId: string;
  instance?: string;
  region?: string;
  watch?: boolean;
  host: string;
  httpServer: Server;
  watcher: ViteDevServer['watcher'];
  logger: ViteDevServer['config']['logger'];
  bridge: BridgeMount;
  baseEnv: NodeJS.ProcessEnv;
  registerUrl: string;
  childModuleUrl?: string | URL;
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
    logger.error(`  ✖ [pyric] Functions child exited unexpectedly (code ${event.code}).`);
    return;
  }
  const childEvent = event.event;
  if (childEvent.type === 'execution') {
    const params = Object.entries(childEvent.params)
      .map(([name, value]) => `${name}=${value}`)
      .join(', ');
    const suffix = params ? ` (${params})` : '';
    if (childEvent.status === 'fulfilled') {
      logger.info(`  ✔ [pyric] function ${childEvent.exportName} ← /${childEvent.ref}${suffix}`);
    } else {
      logger.error(
        `  ✖ [pyric] function ${childEvent.exportName} ← /${childEvent.ref}${suffix}: ${childEvent.error.message}`,
      );
    }
  } else {
    logger.error(
      `  ✖ [pyric] functions delivery for ${childEvent.exportName}: ${childEvent.error.message}`,
    );
  }
}

function reportResult(
  options: ViteFunctionsDevelopmentOptions,
  result: FunctionsDevelopmentResult,
  mode: 'initial' | 'reload',
  serveUrl: string,
): void {
  const { logger, project, cwd } = options;
  if (result.kind === 'no-peer') {
    logger.warn(
      mode === 'reload'
        ? `  ✖ [pyric] functions not restarted — no sandbox peer connected. ` +
            `Functions stay down until the next save with ${serveUrl} open.`
        : `  ⚠ [pyric] functions not started — no browser tab connected after 30s. ` +
            `Open ${serveUrl} and restart the dev server.`,
    );
    return;
  }
  if (result.kind === 'failed') {
    logger.error(
      mode === 'reload'
        ? `  ✖ [pyric] functions failed to reload: ${result.error.message}\n` +
            `  ✖ [pyric] functions are down until the next good save.`
        : `  ✖ [pyric] functions failed to start: ${result.error.message}`,
    );
    return;
  }
  const ready = result.ready;
  logger.info(
    mode === 'reload'
      ? `  ↻ [pyric] functions reloaded (${ready.triggerCount} trigger${ready.triggerCount === 1 ? '' : 's'})`
      : `  ✔ [pyric] functions ${ready.triggerCount} onValueCreated ` +
          `trigger${ready.triggerCount === 1 ? '' : 's'} from ${path.relative(cwd, project.entry)}`,
  );
  for (const unsupported of ready.unsupportedTriggers) {
    logger.warn(
      `  ⚠ [pyric] functions export ${unsupported.exportName} uses unsupported trigger ` +
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
  let closePromise: Promise<void> | null = null;

  const serveUrl = (): string | null => {
    const address = httpServer.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    return port > 0 ? `http://${host}:${port}` : null;
  };

  const onListening = (): void => {
    const url = serveUrl();
    if (!url || closed || runtime) return;
    runtime = runtimeFactory({
      sourceDir: project.sourceDir,
      entry: project.entry,
      baseEnv: options.baseEnv,
      serveUrl: url,
      registerUrl: options.registerUrl,
      instance: options.instance ?? `${options.projectId}-default-rtdb`,
      location: options.region ?? options.baseEnv.PYRIC_FUNCTIONS_RTDB_REGION ?? 'us-central1',
      readiness: createInProcessFunctionsPeerReadiness(bridge.sandboxConnected),
      onEvent: (event) => reportEvent(options.logger, event),
      ...(options.childModuleUrl === undefined ? {} : { childModuleUrl: options.childModuleUrl }),
    });
    void runtime.start().then((result) => {
      if (!closed) reportResult(options, result, 'initial', url);
    });
  };

  const onFunctionsFsEvent = (file: string): void => {
    const resolved = path.resolve(file);
    const rel = path.relative(project.sourceDir, resolved);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return;
    if (rel.split(path.sep).includes('node_modules')) return;
    if (reloadDebounce) clearTimeout(reloadDebounce);
    reloadDebounce = setTimeout(() => {
      if (!runtime || closed) return;
      const transition = runtime.reload();
      if (reportedReload === transition) return;
      reportedReload = transition;
      void transition.then((result) => {
        if (!closed) reportResult(options, result, 'reload', serveUrl() ?? `http://${host}:0`);
      }).finally(() => {
        if (reportedReload === transition) reportedReload = null;
      });
    }, 300);
  };

  if ((httpServer as unknown as { listening?: boolean }).listening) onListening();
  else httpServer.once('listening', onListening);
  if (options.watch !== false) {
    watcher.add(project.sourceDir);
    watcher.on('change', onFunctionsFsEvent);
    watcher.on('add', onFunctionsFsEvent);
    watcher.on('unlink', onFunctionsFsEvent);
  }

  return {
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        closed = true;
        if (reloadDebounce) clearTimeout(reloadDebounce);
        httpServer.removeListener('listening', onListening);
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
