/**
 * The isolated Functions child's entry: it initializes the ambient
 * firebase-admin app, loads the user's Functions source with the real SDK,
 * starts each trigger family, and reports ready to the host over IPC.
 */
import { createRequire } from 'node:module';
import type { RemoteSandbox } from '../remote/index.js';
import {
  isChildMessage,
  serializeError,
  type FunctionsChildMessage,
} from './child-protocol.js';
import { loadFunctionsModuleExports } from './module-loader.js';
import { rtdbCreatedFamily } from './rtdb/discovery.js';
import type { OnValueCreatedExecutionHost } from './rtdb/execution.js';
import { serveInstanceAsDefault, startRtdbChildRuntime } from './rtdb/child-runtime.js';
import { findUnsupportedTriggers } from './unsupported.js';

interface AdminAppModule {
  initializeApp(): { sandbox: RemoteSandbox };
  deleteApp(app: unknown): Promise<void>;
}

function send(message: FunctionsChildMessage): void {
  process.send?.(message);
}

async function runFunctionsChild(): Promise<void> {
  const entry = process.env.PYRIC_FUNCTIONS_ENTRY;
  const instance = process.env.PYRIC_FUNCTIONS_INSTANCE;
  const location = process.env.PYRIC_FUNCTIONS_LOCATION;
  const databaseHost = process.env.PYRIC_FUNCTIONS_DATABASE_HOST;
  if (!entry || !instance || !location || !databaseHost) {
    throw new Error('Functions RTDB child is missing its required environment');
  }

  const requireFromEntry = createRequire(entry);
  const adminApp = requireFromEntry('firebase-admin/app') as AdminAppModule;
  serveInstanceAsDefault(instance);
  const app = adminApp.initializeApp();
  let host: OnValueCreatedExecutionHost | undefined;
  let closing: Promise<void> | undefined;

  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
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
    process.disconnect?.();
  };

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
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

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
    send({
      type: 'ready',
      triggerCount: host.triggerCount,
      unsupportedTriggers: findUnsupportedTriggers(exported, [rtdbCreatedFamily]),
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
