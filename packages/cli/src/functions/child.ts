/**
 * The isolated Functions child's entry: it initializes the ambient
 * firebase-admin app, loads the user's Functions source with the real SDK,
 * starts each trigger family, and reports ready to the host over IPC.
 */
import { createRequire } from 'node:module';
import { LAZY_DEFAULT_AMBIENT_APP } from 'pyric/sandbox/internal';
import { disconnectFromHost, sendToHost } from './child-ipc.js';
import {
  HEARTBEAT_INTERVAL_MS,
  STOP_DEADLINE_MS,
  isChildMessage,
  isHostMessage,
  serializeError,
  type FunctionsChildMessage,
} from './child-protocol.js';
import { callableOnCallFamily, inspectOnCall } from './callable/discovery.js';
import { startFirestoreChildRuntime } from './firestore/child-runtime.js';
import { firestoreTriggersFamily } from './firestore/discovery.js';
import type { FirestoreTriggerExecutionHost } from './firestore/execution.js';
import { startHttpChildServer, type HttpChildServer } from './http/child-server.js';
import { CHILD_TOKEN_ENV, takeChildToken } from './http/child-token.js';
import { httpFunctionInfo, httpOnRequestFamily, inspectOnRequest } from './http/discovery.js';
import { loadFunctionsModuleExports } from './module-loader.js';
import { rtdbValueTriggerFamily } from './rtdb/discovery.js';
import type { RtdbValueExecutionHost } from './rtdb/execution.js';
import {
  connectAmbientRuntimeSandbox,
  serveInstanceAsDefault,
  startRtdbChildRuntime,
} from './rtdb/child-runtime.js';
import {
  defaultStorageBucketFromEnv,
  serveBucketAsDefault,
  startStorageChildRuntime,
} from './storage/child-runtime.js';
import { storageTriggersFamily } from './storage/discovery.js';
import type { StorageTriggerExecutionHost } from './storage/execution.js';
import {
  startSchedulerChildRuntime,
  type SchedulerChildRuntimeHost,
} from './scheduler/child-runtime.js';
import { schedulerTriggersFamily } from './scheduler/discovery.js';
import { startIdentityChildRuntime } from './identity/child-runtime.js';
import { identityBlockingFamily } from './identity/discovery.js';
import type { IdentityTriggerExecutionHost } from './identity/execution.js';
import { findUnsupportedTriggers } from './unsupported.js';

interface AdminAppInstance {
  sandbox?: { close?: () => void };
}

interface AdminAppModule {
  getApps(): AdminAppInstance[];
  deleteApp(app: AdminAppInstance): Promise<void>;
}

const send = (message: FunctionsChildMessage): void => sendToHost(message);

/** With the host gone there is nothing to wait for: close quickly and exit. */
const HOST_LOST_DEADLINE_MS = 1_500;
/** How often the child checks that its parent is still the one that spawned it. */
const PARENT_POLL_MS = 500;
let uncaughtGuardInstalled = false;

/**
 * An exception thrown outside any handler's own call and promise (a timer
 * callback in an onRequest handler, say) would end this process, and with it
 * every RTDB trigger it serves. The owner decision for functions-http#12 is to
 * report it and keep serving instead of restarting.
 */
function surviveUncaughtErrors(): void {
  if (uncaughtGuardInstalled) return;
  uncaughtGuardInstalled = true;
  let reporting = false;
  const report = (error: unknown): void => {
    // Only blocks synchronous re-entry (an error thrown inside the send). The next-tick
    // loop a send on a closed channel used to start is prevented in sendToHost instead.
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

  // Taken before the user's module loads, so function code never reads it.
  const httpToken = takeChildToken(process.env);
  // A handler stuck in a synchronous loop stops these beats, which is how the host
  // tells a wedged child from a busy one.
  const heartbeat = setInterval(() => send({ type: 'heartbeat' }), HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  const requireFromEntry = createRequire(entry);
  const adminApp = requireFromEntry('firebase-admin/app') as AdminAppModule;
  const defaultBucket = defaultStorageBucketFromEnv(process.env);
  serveInstanceAsDefault(instance);
  serveBucketAsDefault(defaultBucket);
  (globalThis as Record<symbol, unknown>)[LAZY_DEFAULT_AMBIENT_APP] = true;
  const runtimeSandbox = connectAmbientRuntimeSandbox(process.env);
  let host: RtdbValueExecutionHost | undefined;
  let storageHost: StorageTriggerExecutionHost | undefined;
  let firestoreHost: FirestoreTriggerExecutionHost | undefined;
  let schedulerHost: SchedulerChildRuntimeHost | undefined;
  let identityHost: IdentityTriggerExecutionHost | undefined;
  let httpServer: HttpChildServer | undefined;
  let closing: Promise<void> | undefined;
  let stopRequested = false;

  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      process.off('message', onParentMessage);
      clearInterval(heartbeat);
      clearInterval(parentWatch);
      await httpServer?.close();
      identityHost?.close();
      await identityHost?.idle();
      schedulerHost?.close();
      await schedulerHost?.idle();
      storageHost?.close();
      await storageHost?.idle();
      firestoreHost?.close();
      host?.close();
      await Promise.all([firestoreHost?.idle(), host?.idle()]);
      delete (globalThis as Record<symbol, unknown>)[LAZY_DEFAULT_AMBIENT_APP];
      runtimeSandbox.close();
      const apps = adminApp.getApps();
      for (const app of apps) {
        app.sandbox?.close?.();
      }
      await Promise.all(apps.map((app) => adminApp.deleteApp(app).catch(() => undefined)));
    })();
    return closing;
  };

  const shutdown = async (): Promise<void> => {
    await close();
    send({ type: 'stopped' });
    disconnectFromHost();
  };

  // The host is gone (its channel closed, or this process was re-parented) or asked
  // us to stop by signal: close what can be closed, and exit by the deadline either way.
  let exiting = false;
  const exitSoon = (deadlineMs: number): void => {
    if (exiting) return;
    exiting = true;
    setTimeout(() => process.exit(process.exitCode ?? 0), deadlineMs);
    void close().catch(() => undefined).finally(() => process.exit(process.exitCode ?? 0));
  };
  const hostLost = (): void => exitSoon(HOST_LOST_DEADLINE_MS);
  process.once('disconnect', hostLost);
  const spawnedBy = process.ppid;
  const parentWatch = setInterval(() => {
    if (process.ppid !== spawnedBy) hostLost();
  }, PARENT_POLL_MS);
  parentWatch.unref();

  const onParentMessage = (raw: unknown): void => {
    if (isChildMessage(raw) && raw.type === 'stopped') return;
    if (!isHostMessage(raw)) return;
    if (raw.type === 'stop') {
      if (stopRequested) return;
      stopRequested = true;
      void shutdown().catch((error) => {
        send({ type: 'fatal', error: serializeError(error) });
        process.exitCode = 1;
        disconnectFromHost();
      });
      return;
    }
    if (raw.type === 'trigger-scheduled') {
      if (schedulerHost === undefined || stopRequested) {
        send({
          type: 'trigger-scheduled-result',
          requestId: raw.requestId,
          outcome: 'invalid-argument',
          exportName: raw.exportName,
          message: 'Functions scheduler runtime is not ready',
        });
        return;
      }
      void schedulerHost
        .handleHostTriggerRequest(raw)
        .then((reply) => {
          send(reply);
        })
        .catch((error: unknown) => {
          send({
            type: 'trigger-scheduled-result',
            requestId: raw.requestId,
            outcome: 'invalid-argument',
            exportName: raw.exportName,
            message: error instanceof Error ? error.message : String(error),
          });
        });
    }
  };
  process.on('message', onParentMessage);
  // Ctrl-C reaches this process directly, alongside the host's own stop request.
  // Its deadline is the host's force-kill deadline, so in-flight triggers get the
  // same time either way.
  const onSignal = (): void => {
    void shutdown().catch(() => undefined);
    exitSoon(STOP_DEADLINE_MS);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    const projectId =
      process.env.GCLOUD_PROJECT ??
      process.env.GOOGLE_CLOUD_PROJECT ??
      'demo-project';
    const exported = await loadFunctionsModuleExports(entry);
    host = startRtdbChildRuntime({
      exported,
      sandbox: runtimeSandbox,
      instance,
      location,
      databaseHost,
      send,
    });
    await host.ready;
    storageHost = startStorageChildRuntime({
      exported,
      sandbox: runtimeSandbox,
      defaultBucket,
      location,
      send,
    });
    await storageHost.ready;
    if (storageHost.triggerCount > 0) {
      surviveUncaughtErrors();
    }
    firestoreHost = startFirestoreChildRuntime({
      entry,
      exported,
      sandbox: runtimeSandbox,
      projectId,
      location,
      send,
    });
    await firestoreHost.ready;
    if (firestoreHost.triggerCount > 0) {
      surviveUncaughtErrors();
    }
    schedulerHost = startSchedulerChildRuntime({
      exported,
      sandbox: runtimeSandbox,
      location,
      projectId,
      send,
    });
    await schedulerHost.ready;
    if (schedulerHost.triggerCount > 0) {
      surviveUncaughtErrors();
    }
    identityHost = startIdentityChildRuntime({
      entry,
      exported,
      sandbox: runtimeSandbox,
      send,
    });
    await identityHost.ready;
    if (identityHost.triggerCount > 0) {
      surviveUncaughtErrors();
    }
    const httpFunctions = [...inspectOnRequest(exported), ...inspectOnCall(exported)];
    if (httpFunctions.length > 0) {
      if (httpToken === undefined) throw new Error(`Functions child is missing ${CHILD_TOKEN_ENV}`);
      surviveUncaughtErrors();
      httpServer = await startHttpChildServer(entry, httpFunctions, { token: httpToken });
    }
    const unsupportedTriggers = findUnsupportedTriggers(exported, [
      rtdbValueTriggerFamily,
      storageTriggersFamily,
      firestoreTriggersFamily,
      schedulerTriggersFamily,
      identityBlockingFamily,
      httpOnRequestFamily,
      callableOnCallFamily,
    ]);
    const totalTriggerCount =
      host.triggerCount +
      storageHost.triggerCount +
      firestoreHost.triggerCount +
      schedulerHost.triggerCount +
      identityHost.triggerCount;
    if (httpServer === undefined) {
      send({
        type: 'ready',
        triggerCount: totalTriggerCount,
        unsupportedTriggers,
      });
    } else {
      send({
        type: 'ready',
        triggerCount: totalTriggerCount,
        unsupportedTriggers,
        http: { port: httpServer.port, functions: httpFunctions.map(httpFunctionInfo) },
      });
    }
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
    disconnectFromHost();
  });
}
