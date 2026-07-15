import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { RemoteSandbox } from '../remote/index.js';
import {
  startOnValueCreatedExecution,
  type OnValueCreatedExecutionHost,
} from './execution.js';
import {
  inspectOnValueCreated,
  listFirebaseEndpoints,
} from './discovery.js';
import type { CreatedExecutionResult } from './event.js';
import { RemoteRtdbTriggerDelivery } from './remote-delivery.js';

export interface SerializedFunctionsRtdbError {
  name: string;
  message: string;
  stack?: string;
}

export type FunctionsRtdbChildEvent =
  | {
      type: 'execution';
      exportName: string;
      ref: string;
      params: Record<string, string>;
      status: 'fulfilled';
    }
  | {
      type: 'execution';
      exportName: string;
      ref: string;
      params: Record<string, string>;
      status: 'rejected';
      error: SerializedFunctionsRtdbError;
    }
  | {
      type: 'delivery-error';
      exportName: string;
      error: SerializedFunctionsRtdbError;
    };

export interface FunctionsRtdbChildReady {
  triggerCount: number;
  unsupportedTriggers: UnsupportedFunctionsTrigger[];
}

export interface UnsupportedFunctionsTrigger {
  exportName: string;
  eventType: string;
}

export interface SpawnFunctionsRtdbChildOptions {
  cwd: string;
  entry: string;
  env: NodeJS.ProcessEnv;
  instance: string;
  location: string;
  databaseHost?: string;
  childModuleUrl?: string | URL;
  nodeExecutable?: string;
  onEvent?(event: FunctionsRtdbChildEvent): void;
}

export interface FunctionsRtdbChildHandle {
  child: ChildProcess;
  ready: Promise<FunctionsRtdbChildReady>;
  exited: Promise<number>;
  stop(): Promise<number>;
}

type FunctionsRtdbChildMessage =
  | ({ type: 'ready' } & FunctionsRtdbChildReady)
  | FunctionsRtdbChildEvent
  | { type: 'fatal'; error: SerializedFunctionsRtdbError }
  | { type: 'stopped' };

const FORCE_KILL_AFTER_MS = 2_000;

function serializeError(error: unknown): SerializedFunctionsRtdbError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    };
  }
  return { name: 'Error', message: String(error) };
}

function isChildMessage(value: unknown): value is FunctionsRtdbChildMessage {
  return typeof value === 'object' && value !== null && 'type' in value;
}

/** Spawn the real Firebase Functions SDK in an isolated Node process. */
export function spawnFunctionsRtdbChild(
  options: SpawnFunctionsRtdbChildOptions,
): FunctionsRtdbChildHandle {
  const childModuleUrl = options.childModuleUrl ?? new URL('./child.js', import.meta.url);
  const childModulePath = typeof childModuleUrl === 'string' && !childModuleUrl.startsWith('file:')
    ? resolve(childModuleUrl)
    : fileURLToPath(childModuleUrl);
  const child = spawn(options.nodeExecutable ?? 'node', [childModulePath], {
    cwd: options.cwd,
    env: {
      ...options.env,
      PYRIC_FUNCTIONS_RTDB_CHILD: '1',
      PYRIC_FUNCTIONS_ENTRY: resolve(options.entry),
      PYRIC_FUNCTIONS_INSTANCE: options.instance,
      PYRIC_FUNCTIONS_LOCATION: options.location,
      PYRIC_FUNCTIONS_DATABASE_HOST: options.databaseHost ?? 'firebasedatabase.app',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  let readySettled = false;
  let stopping = false;
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-8_192);
  });

  let resolveReady!: (ready: FunctionsRtdbChildReady) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<FunctionsRtdbChildReady>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });

  child.on('message', (raw: unknown) => {
    if (!isChildMessage(raw)) return;
    if (raw.type === 'ready') {
      readySettled = true;
      resolveReady({
        triggerCount: raw.triggerCount,
        unsupportedTriggers: raw.unsupportedTriggers,
      });
    } else if (raw.type === 'fatal') {
      if (!readySettled) {
        readySettled = true;
        rejectReady(new Error(
          `Functions RTDB child failed: ${raw.error.stack ?? raw.error.message}`,
        ));
      }
    } else if (raw.type === 'execution' || raw.type === 'delivery-error') {
      options.onEvent?.(raw);
    }
  });

  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const exited = new Promise<number>((resolveExited) => {
    child.once('error', (error) => {
      if (!readySettled) {
        readySettled = true;
        rejectReady(error);
      }
    });
    child.once('close', (code, signal) => {
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      const exitCode = typeof code === 'number' ? code : signal ? 1 : 0;
      if (!readySettled) {
        readySettled = true;
        const diagnostic = stderr.trim();
        rejectReady(new Error(
          `Functions RTDB child exited before ready (code ${exitCode})` +
            (diagnostic ? `\n${diagnostic}` : ''),
        ));
      }
      resolveExited(exitCode);
    });
  });

  return {
    child,
    ready,
    exited,
    async stop(): Promise<number> {
      if (child.exitCode !== null || child.signalCode !== null) return exited;
      if (!stopping) {
        stopping = true;
        if (child.connected) child.send({ type: 'stop' });
        else child.kill('SIGTERM');
        forceTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, FORCE_KILL_AFTER_MS);
        forceTimer.unref();
      }
      return exited;
    },
  };
}

interface AdminAppModule {
  initializeApp(): { sandbox: RemoteSandbox };
  deleteApp(app: unknown): Promise<void>;
}

function send(message: FunctionsRtdbChildMessage): void {
  process.send?.(message);
}

function usesCommonJs(entry: string): boolean {
  const extension = extname(entry);
  if (extension === '.cjs') return true;
  if (extension === '.mjs') return false;

  let directory = dirname(entry);
  while (true) {
    const packageJsonPath = join(directory, 'package.json');
    if (existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
        type?: unknown;
      };
      return packageJson.type !== 'module';
    }
    const parent = dirname(directory);
    if (parent === directory) return true;
    directory = parent;
  }
}

/** Load the entry with the semantics selected by its extension and package scope. */
async function loadFunctionsExports(entry: string): Promise<Record<string, unknown>> {
  if (usesCommonJs(entry)) {
    return createRequire(entry)(entry) as Record<string, unknown>;
  }
  return await import(pathToFileURL(entry).href) as Record<string, unknown>;
}

async function runFunctionsRtdbChild(): Promise<void> {
  const entry = process.env.PYRIC_FUNCTIONS_ENTRY;
  const instance = process.env.PYRIC_FUNCTIONS_INSTANCE;
  const location = process.env.PYRIC_FUNCTIONS_LOCATION;
  const databaseHost = process.env.PYRIC_FUNCTIONS_DATABASE_HOST;
  if (!entry || !instance || !location || !databaseHost) {
    throw new Error('Functions RTDB child is missing its required environment');
  }

  const requireFromEntry = createRequire(entry);
  const adminApp = requireFromEntry('firebase-admin/app') as AdminAppModule;
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
    const exported = await loadFunctionsExports(entry);
    const effectiveInstances = [...new Set(
      inspectOnValueCreated(exported).triggers.map((trigger) =>
        trigger.instance === '*' ? instance : trigger.instance,
      ),
    )].sort();
    if (effectiveInstances.length > 1) {
      throw new Error(
        'Functions RTDB first slice supports one database instance; found ' +
          effectiveInstances.join(', '),
      );
    }
    host = startOnValueCreatedExecution({
      exported,
      delivery: new RemoteRtdbTriggerDelivery(app.sandbox.rtdb),
      eventOptions: (_projection, sequence, trigger) => ({
        id: `${randomUUID()}-${sequence}`,
        time: new Date().toISOString(),
        instance: trigger.instance === '*' ? instance : trigger.instance,
        location: trigger.location ?? location,
        databaseHost,
      }),
      onExecution(result, trigger, projection) {
        sendExecution(result, trigger.exportName, projection.ref, projection.params);
      },
      onDeliveryError(error, trigger) {
        send({
          type: 'delivery-error',
          exportName: trigger.exportName,
          error: serializeError(error),
        });
      },
    });
    await host.ready;
    send({
      type: 'ready',
      triggerCount: host.triggerCount,
      unsupportedTriggers: findUnsupportedTriggers(exported),
    });
  } catch (error) {
    await close();
    throw error;
  }
}

function findUnsupportedTriggers(exported: Record<string, unknown>): UnsupportedFunctionsTrigger[] {
  const unsupported: UnsupportedFunctionsTrigger[] = [
    ...inspectOnValueCreated(exported).unsupported,
  ];
  for (const { exportName, callable } of listFirebaseEndpoints(exported)) {
    const endpoint = callable.__endpoint;
    if (!endpoint) continue;
    const eventType = endpoint.eventTrigger?.eventType;
    if (eventType === 'google.firebase.database.ref.v1.created') continue;
    const label = typeof eventType === 'string'
      ? eventType
      : endpoint.callableTrigger !== undefined
        ? 'callable'
        : endpoint.httpsTrigger !== undefined
          ? 'https'
          : endpoint.scheduleTrigger !== undefined
            ? 'schedule'
            : endpoint.taskQueueTrigger !== undefined
              ? 'task-queue'
              : 'unknown';
    unsupported.push({ exportName, eventType: label });
  }
  return unsupported;
}

function sendExecution(
  result: CreatedExecutionResult,
  exportName: string,
  ref: string,
  params: Record<string, string>,
): void {
  if (result.status === 'fulfilled') {
    send({ type: 'execution', exportName, ref, params, status: 'fulfilled' });
  } else {
    send({
      type: 'execution',
      exportName,
      ref,
      params,
      status: 'rejected',
      error: serializeError(result.error),
    });
  }
}

if (process.env.PYRIC_FUNCTIONS_RTDB_CHILD === '1') {
  void runFunctionsRtdbChild().catch((error) => {
    const serialized = serializeError(error);
    send({ type: 'fatal', error: serialized });
    process.stderr.write(`${serialized.stack ?? `${serialized.name}: ${serialized.message}`}\n`);
    process.exitCode = 1;
    process.disconnect?.();
  });
}
