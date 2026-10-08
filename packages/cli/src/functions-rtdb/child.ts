import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { WorkerOpPayload, WorkerSubPayload } from '../bridge/protocol.js';
import {
  createRemoteSandboxHandle,
  type RemoteSandbox,
  type RemoteSandboxChannel,
} from '../remote/index.js';
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
  /** The project the child runs as, from `resolveFirebaseProject`. */
  projectId: string;
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

export interface FunctionsChildEnvOptions {
  baseEnv: NodeJS.ProcessEnv;
  entry: string;
  instance: string;
  location: string;
  databaseHost: string;
  projectId: string;
}

/**
 * Resolve the database host, defaulting to 'firebasedatabase.app'.
 */
export function resolveChildDatabaseHost(databaseHost?: string): string {
  if (typeof databaseHost === 'string' && databaseHost.length > 0) {
    return databaseHost;
  }
  return 'firebasedatabase.app';
}

/**
 * Resolve the filesystem path to the child entrypoint module.
 */
export function resolveChildModulePath(childModuleUrl?: string | URL): string {
  if (!childModuleUrl) {
    return fileURLToPath(new URL('./child.js', import.meta.url));
  }
  if (typeof childModuleUrl === 'string' && !childModuleUrl.startsWith('file:')) {
    return resolve(childModuleUrl);
  }
  return fileURLToPath(childModuleUrl);
}

/**
 * Assemble the child process environment variables.
 *
 * Guaranteed child-only synthetic sandbox metadata:
 * - GCLOUD_PROJECT is set to the resolved sandbox project ID
 * - FIREBASE_CONFIG is set to synthetic JSON with projectId, databaseURL, and storageBucket
 *
 * Explicit control flow ensures that host environment cannot pollute or route
 * sandbox functions execution to a production Firebase/GCP project.
 */
export function buildFunctionsChildEnv(options: FunctionsChildEnvOptions): NodeJS.ProcessEnv {
  const { baseEnv, entry, instance, location, databaseHost, projectId } = options;

  const resolvedEntry = resolve(entry);
  const databaseURL = `https://${instance}.${databaseHost}`;
  const storageBucket = `${projectId}.appspot.com`;

  const syntheticFirebaseConfig = JSON.stringify({
    projectId,
    databaseURL,
    storageBucket,
  });

  const childEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    PYRIC_FUNCTIONS_RTDB_CHILD: '1',
    PYRIC_FUNCTIONS_ENTRY: resolvedEntry,
    PYRIC_FUNCTIONS_INSTANCE: instance,
    PYRIC_FUNCTIONS_LOCATION: location,
    PYRIC_FUNCTIONS_DATABASE_HOST: databaseHost,
    GCLOUD_PROJECT: projectId,
    FIREBASE_CONFIG: syntheticFirebaseConfig,
  };

  return childEnv;
}

/** Spawn the real Firebase Functions SDK in an isolated Node process. */
export function spawnFunctionsRtdbChild(
  options: SpawnFunctionsRtdbChildOptions,
): FunctionsRtdbChildHandle {
  const childModulePath = resolveChildModulePath(options.childModuleUrl);
  const { projectId } = options;
  const databaseHost = resolveChildDatabaseHost(options.databaseHost);
  const childEnv = buildFunctionsChildEnv({
    baseEnv: options.env,
    entry: options.entry,
    instance: options.instance,
    location: options.location,
    databaseHost,
    projectId,
  });

  const nodeExecutable = options.nodeExecutable ?? 'node';
  const child = spawn(nodeExecutable, [childModulePath], {
    cwd: options.cwd,
    env: childEnv,
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

/** The current instant of the sandbox this child is attached to. */
async function sandboxNow(sandbox: RemoteSandbox): Promise<number> {
  const read = (await sandbox.channel.op({ method: 'sandbox.clock' })) as { now: number };
  return read.now;
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

/**
 * The configured instance name is the name of the default instance: the
 * `functions.instance` option renames `<projectId>-default-rtdb`, and the host
 * serves that instance without a name. Wrap the remote sandbox factory that
 * `@pyric/cli/register` installs so every RTDB op and value subscription this
 * child sends for `name`, from firebase-admin or from trigger delivery,
 * reaches the default instance.
 */
function serveInstanceAsDefault(name: string): void {
  const key = Symbol.for('pyric.remote.sandboxFactory');
  const global = globalThis as Record<symbol, unknown>;
  const factory = global[key] as ((options?: { url?: string }) => RemoteSandbox) | undefined;
  if (typeof factory !== 'function') return;
  global[key] = (options?: { url?: string }): RemoteSandbox => {
    const inner = factory(options);
    return createRemoteSandboxHandle({
      channel: aliasDefaultInstance(inner.channel, name),
      serveUrl: inner.serveUrl,
      close: () => inner.close(),
    });
  };
}

/** A channel that sends `instance: name` as the default instance. */
function aliasDefaultInstance(channel: RemoteSandboxChannel, name: string): RemoteSandboxChannel {
  const alias = (instance: unknown): unknown => (instance === name ? undefined : instance);
  return {
    op: (payload) => channel.op(
      'instance' in payload ? { ...payload, instance: alias(payload.instance) } as WorkerOpPayload : payload,
    ),
    subscribe: (sub, onSnap, onError) => {
      const target = sub.target;
      const isRtdb = typeof target === 'object' && target !== null && 'service' in target && target.service === 'rtdb';
      const aliased = isRtdb ? { ...sub, target: { ...target, instance: alias(target.instance) } } as WorkerSubPayload : sub;
      return channel.subscribe(aliased, onSnap, onError);
    },
    byteRoute: () => channel.byteRoute?.() ?? Promise.resolve(undefined),
  };
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
    // Deliver from the instance the triggers name.
    const rtdb = app.sandbox.rtdb.forInstance(effectiveInstances[0] ?? instance);
    host = startOnValueCreatedExecution({
      exported,
      delivery: new RemoteRtdbTriggerDelivery(rtdb),
      eventOptions: async (_projection, sequence, trigger) => ({
        id: `${randomUUID()}-${sequence}`,
        // The delivery's instant is the sandbox's, not this process's: the
        // write that triggered it was stamped by that clock, and a CloudEvent
        // claiming a different `time` would contradict the data it carries.
        time: new Date(await sandboxNow(app.sandbox)).toISOString(),
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
