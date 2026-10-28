/**
 * The host side of the isolated Functions child: its environment, its entry
 * module, and the spawn, ready, and stop handshake over IPC.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STOP_DEADLINE_MS,
  isChildMessage,
  type FunctionsChildEvent,
  type FunctionsChildReady,
} from './child-protocol.js';

export interface SpawnFunctionsChildOptions {
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
  onEvent?(event: FunctionsChildEvent): void;
  /** Called once when a ready child misses heartbeats for `heartbeatTimeoutMs`. */
  onUnresponsive?(): void;
  heartbeatTimeoutMs?: number;
}

export interface FunctionsChildHandle {
  child: ChildProcess;
  ready: Promise<FunctionsChildReady>;
  exited: Promise<number>;
  stop(): Promise<number>;
}

const FORCE_KILL_AFTER_MS = STOP_DEADLINE_MS;

/** Ten missed beats: long enough for a slow synchronous handler, short enough to notice a loop. */
const HEARTBEAT_TIMEOUT_MS = 10_000;

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
 * - GCLOUD_PROJECT, GOOGLE_CLOUD_PROJECT and GCP_PROJECT are set to the
 *   resolved sandbox project ID, as production sets them to the function's
 *   own project (the Firebase emulator reserves the same three)
 * - FIREBASE_CONFIG is set to synthetic JSON with projectId, databaseURL, and storageBucket
 * - GOOGLE_APPLICATION_CREDENTIALS is removed, so a Google client in function
 *   code never loads the host's credentials file
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
    GOOGLE_CLOUD_PROJECT: projectId,
    GCP_PROJECT: projectId,
    FIREBASE_CONFIG: syntheticFirebaseConfig,
  };
  delete childEnv.GOOGLE_APPLICATION_CREDENTIALS;

  return childEnv;
}

/** Spawn the real Firebase Functions SDK in an isolated Node process. */
export function spawnFunctionsChild(
  options: SpawnFunctionsChildOptions,
): FunctionsChildHandle {
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
  let lastBeat = Date.now();
  let reportedUnresponsive = false;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  const watchHeartbeat = (): void => {
    lastBeat = Date.now();
    watchdog = setInterval(() => {
      const silent = Date.now() - lastBeat > heartbeatTimeoutMs;
      if (!silent || reportedUnresponsive || stopping) return;
      reportedUnresponsive = true;
      options.onUnresponsive?.();
    }, Math.min(1_000, heartbeatTimeoutMs / 2));
    watchdog.unref();
  };
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-8_192);
  });

  let resolveReady!: (ready: FunctionsChildReady) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<FunctionsChildReady>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });

  child.on('message', (raw: unknown) => {
    if (!isChildMessage(raw)) return;
    if (raw.type === 'heartbeat') {
      lastBeat = Date.now();
    } else if (raw.type === 'ready') {
      readySettled = true;
      watchHeartbeat();
      resolveReady({
        triggerCount: raw.triggerCount,
        unsupportedTriggers: raw.unsupportedTriggers,
        ...(raw.http === undefined ? {} : { http: raw.http }),
      });
    } else if (raw.type === 'fatal') {
      if (!readySettled) {
        readySettled = true;
        rejectReady(new Error(
          `Functions RTDB child failed: ${raw.error.stack ?? raw.error.message}`,
        ));
      }
    } else if (raw.type === 'execution' || raw.type === 'delivery-error' || raw.type === 'uncaught-error') {
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
      if (watchdog !== undefined) clearInterval(watchdog);
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
