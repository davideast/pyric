/**
 * The isolated Functions child's entry: it initializes the ambient
 * firebase-admin app, loads the user's Functions source with the real SDK,
 * starts each trigger family, and reports ready to the host over IPC.
 */
import { createRequire } from 'node:module';
import type { RemoteSandbox } from '../remote/index.js';
import {
  HEARTBEAT_INTERVAL_MS,
  isChildMessage,
  serializeError,
  type FunctionsChildMessage,
} from './child-protocol.js';
import { startHttpChildServer, type HttpChildServer } from './http/child-server.js';
import { httpFunctionInfo, httpOnRequestFamily, inspectOnRequest } from './http/discovery.js';
import { loadFunctionsModuleExports } from './module-loader.js';
import { rtdbCreatedFamily } from './rtdb/discovery.js';
import type { OnValueCreatedExecutionHost } from './rtdb/execution.js';
import { serveInstanceAsDefault, startRtdbChildRuntime } from './rtdb/child-runtime.js';
import { findUnsupportedTriggers } from './unsupported.js';

interface AdminAppModule {
  initializeApp(): { sandbox: RemoteSandbox };
  deleteApp(app: unknown): Promise<void>;
}

/**
 * Send to the host if the channel is open. The callback matters: without one,
 * a send on a channel that closed emits 'error' on the next tick, and with the
 * uncaught-error handler installed that error is reported by sending again, a
 * next-tick loop that spins a core and starves every signal handler.
 */
function send(message: FunctionsChildMessage): void {
  if (!process.connected || !process.send) return;
  process.send(message, (error: Error | null) => {
    // The channel closed between the check and the write; the disconnect handler ends this process.
    void error;
  });
}

/** How long any shutdown may take before the child exits regardless. */
const EXIT_DEADLINE_MS = 1_500;
/** How often the child checks that its parent is still the one that spawned it. */
const PARENT_POLL_MS = 500;

/**
 * An exception thrown outside any handler's own call and promise (a timer
 * callback in an onRequest handler, say) would end this process, and with it
 * every RTDB trigger it serves. The owner decision for functions-http#12 is to
 * report it and keep serving instead of restarting.
 */
function surviveUncaughtErrors(): void {
  let reporting = false;
  const report = (error: unknown): void => {
    // Never re-enter: an error raised while reporting is dropped rather than reported again.
    if (reporting) return;
    reporting = true;
    try {
      send({ type: 'uncaught-error', error: serializeError(error) });
    } finally {
      reporting = false;
    }
  };
  process.on('uncaughtException', report);
  process.on('unhandledRejection', report);
}

async function runFunctionsChild(): Promise<void> {
  const entry = process.env.PYRIC_FUNCTIONS_ENTRY;
  const instance = process.env.PYRIC_FUNCTIONS_INSTANCE;
  const location = process.env.PYRIC_FUNCTIONS_LOCATION;
  const databaseHost = process.env.PYRIC_FUNCTIONS_DATABASE_HOST;
  if (!entry || !instance || !location || !databaseHost) {
    throw new Error('Functions RTDB child is missing its required environment');
  }

  // A handler stuck in a synchronous loop stops these beats, which is how the host
  // tells a wedged child from a busy one.
  const heartbeat = setInterval(() => send({ type: 'heartbeat' }), HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  const requireFromEntry = createRequire(entry);
  const adminApp = requireFromEntry('firebase-admin/app') as AdminAppModule;
  serveInstanceAsDefault(instance);
  const app = adminApp.initializeApp();
  let host: OnValueCreatedExecutionHost | undefined;
  let httpServer: HttpChildServer | undefined;
  let closing: Promise<void> | undefined;

  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      clearInterval(heartbeat);
      clearInterval(parentWatch);
      await httpServer?.close();
      host?.close();
      await host?.idle();
      app.sandbox.close();
      await adminApp.deleteApp(app);
    })();
    return closing;
  };

  const shutdown = async (): Promise<void> => {
    await close();
    send({ type: 'stopped' });
    if (process.connected) process.disconnect?.();
  };

  // The host is gone (its channel closed, or this process was re-parented) or asked
  // us to stop by signal: close what can be closed, and exit by the deadline either way.
  let exiting = false;
  const exitSoon = (): void => {
    if (exiting) return;
    exiting = true;
    setTimeout(() => process.exit(process.exitCode ?? 0), EXIT_DEADLINE_MS);
    void close().catch(() => undefined).finally(() => process.exit(process.exitCode ?? 0));
  };
  process.once('disconnect', exitSoon);
  const spawnedBy = process.ppid;
  const parentWatch = setInterval(() => {
    if (process.ppid !== spawnedBy) exitSoon();
  }, PARENT_POLL_MS);
  parentWatch.unref();

  process.once('message', (raw: unknown) => {
    if (isChildMessage(raw) && raw.type === 'stopped') return;
    if (typeof raw === 'object' && raw !== null && 'type' in raw && raw.type === 'stop') {
      void shutdown().catch((error) => {
        send({ type: 'fatal', error: serializeError(error) });
        process.exitCode = 1;
        process.disconnect?.();
      });
    }
  });
  const onSignal = (): void => {
    void shutdown().catch(() => undefined);
    exitSoon();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    // The real database provider asks firebase-admin/app for its default app
    // when it wraps a raw CloudEvent. Initializing that app before loading the
    // user's module avoids importing the broad firebase-functions/v2 barrel.
    const exported = await loadFunctionsModuleExports(entry);
    host = startRtdbChildRuntime({
      exported,
      sandbox: app.sandbox,
      instance,
      location,
      databaseHost,
      send,
    });
    await host.ready;
    const httpFunctions = inspectOnRequest(exported);
    if (httpFunctions.length > 0) {
      surviveUncaughtErrors();
      httpServer = await startHttpChildServer(entry, httpFunctions);
    }
    send({
      type: 'ready',
      triggerCount: host.triggerCount,
      unsupportedTriggers: findUnsupportedTriggers(exported, [rtdbCreatedFamily, httpOnRequestFamily]),
      ...(httpServer === undefined
        ? {}
        : { http: { port: httpServer.port, functions: httpFunctions.map(httpFunctionInfo) } }),
    });
  } catch (error) {
    await close();
    throw error;
  }
}

if (process.env.PYRIC_FUNCTIONS_RTDB_CHILD === '1') {
  void runFunctionsChild().catch((error) => {
    const serialized = serializeError(error);
    send({ type: 'fatal', error: serialized });
    process.stderr.write(`${serialized.stack ?? `${serialized.name}: ${serialized.message}`}\n`);
    process.exitCode = 1;
    process.disconnect?.();
  });
}
