/**
 * The host side of the isolated Functions child: its environment, its entry
 * module, and the spawn, ready, and stop handshake over IPC.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STOP_DEADLINE_MS,
  isChildMessage,
  type FunctionsChildEvent,
  type FunctionsChildReady,
} from './child-protocol.js';
import {
  STRIPPED_FUNCTIONS_ENV_KEYS,
  applyFunctionsDotenv,
  resolveFunctionsSourceDir,
} from './dotenv.js';
import { HEARTBEAT_FLOOR_MS, heartbeatLimitMs, watchHeartbeat, type HeartbeatWatch } from './heartbeat.js';
import { CHILD_TOKEN_ENV, createChildToken } from './http/child-token.js';

export interface SpawnFunctionsChildOptions {
  cwd: string;
  entry: string;
  env: NodeJS.ProcessEnv;
  instance: string;
  location: string;
  databaseHost?: string;
  storageBucket?: string;
  /** The project the child runs as, from `resolveFirebaseProject`. */
  projectId: string;
  childModuleUrl?: string | URL;
  nodeExecutable?: string;
  onEvent?(event: FunctionsChildEvent): void;
  /**
   * Called once when a ready child stays silent past `heartbeatTimeoutMs`, or
   * past the longest `timeoutSeconds` among its triggers when that is longer.
   */
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

export interface FunctionsChildEnvOptions {
  baseEnv: NodeJS.ProcessEnv;
  entry: string;
  sourceDir?: string;
  instance: string;
  location: string;
  databaseHost: string;
  storageBucket?: string;
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
 * Guaranteed child-only synthetic sandbox metadata, `.env` loading, and credential isolation:
 * - `.env`, `.env.<project>`, and `.env.local` in the Functions source directory
 *   are loaded in Firebase's documented precedence order while refusing reserved
 *   and credential-bearing keys.
 * - GCLOUD_PROJECT, GOOGLE_CLOUD_PROJECT and GCP_PROJECT are set to the
 *   resolved sandbox project ID, as production sets them to the function's
 *   own project (the Firebase emulator reserves the same three), and any
 *   lowercase or mixed-case host variants are removed.
 * - FIREBASE_CONFIG is set to synthetic JSON with projectId, databaseURL, and
 *   storageBucket (`<projectId>.firebasestorage.app` by default).
 * - Host Google credential and quota variables (GOOGLE_APPLICATION_CREDENTIALS,
 *   google_application_credentials, FIREBASE_SA_BASE64, and
 *   GOOGLE_CLOUD_QUOTA_PROJECT, case-insensitively) are stripped from the child env.
 * - Well-known Application Default Credentials lookup directories (CLOUDSDK_CONFIG,
 *   HOME, APPDATA, USERPROFILE) are redirected to a non-existent path under the
 *   resolved entry path so google-auth-library and gcloud ADC helpers do not fall
 *   back to the developer's `~/.config/gcloud/application_default_credentials.json`.
 */
export function buildFunctionsChildEnv(options: FunctionsChildEnvOptions): NodeJS.ProcessEnv {
  const { baseEnv, entry, instance, location, databaseHost, projectId } = options;

  const resolvedEntry = resolve(entry);
  const sourceDir = resolveFunctionsSourceDir(resolvedEntry, options.sourceDir);
  const databaseURL = `https://${instance}.${databaseHost}`;
  let storageBucket = `${projectId}.firebasestorage.app`;
  if (typeof options.storageBucket === 'string' && options.storageBucket.length > 0) {
    storageBucket = options.storageBucket;
  }
  const isolatedAdcDir = join(resolvedEntry, '.pyric-isolated-adc');

  const syntheticFirebaseConfig = JSON.stringify({
    projectId,
    databaseURL,
    storageBucket,
  });

  const childEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (STRIPPED_FUNCTIONS_ENV_KEYS.has(key.toLowerCase())) {
      continue;
    }
    childEnv[key] = value;
  }

  applyFunctionsDotenv(childEnv, { sourceDir, projectId });

  childEnv.PYRIC_FUNCTIONS_RTDB_CHILD = '1';
  childEnv.PYRIC_FUNCTIONS_ENTRY = resolvedEntry;
  childEnv.PYRIC_FUNCTIONS_SOURCE_DIR = sourceDir;
  childEnv.PYRIC_FUNCTIONS_INSTANCE = instance;
  childEnv.PYRIC_FUNCTIONS_LOCATION = location;
  childEnv.PYRIC_FUNCTIONS_DATABASE_HOST = databaseHost;
  childEnv.GCLOUD_PROJECT = projectId;
  childEnv.GOOGLE_CLOUD_PROJECT = projectId;
  childEnv.GCP_PROJECT = projectId;
  childEnv.FIREBASE_CONFIG = syntheticFirebaseConfig;
  childEnv.CLOUDSDK_CONFIG = isolatedAdcDir;
  childEnv.HOME = isolatedAdcDir;
  childEnv.APPDATA = isolatedAdcDir;
  childEnv.USERPROFILE = isolatedAdcDir;

  return childEnv;
}

/** Spawn the real Firebase Functions SDK in an isolated Node process. */
export function spawnFunctionsChild(
  options: SpawnFunctionsChildOptions,
): FunctionsChildHandle {
  const childModulePath = resolveChildModulePath(options.childModuleUrl);
  const { projectId } = options;
  const databaseHost = resolveChildDatabaseHost(options.databaseHost);
  const envOptions: FunctionsChildEnvOptions = {
    baseEnv: options.env,
    entry: options.entry,
    sourceDir: options.cwd,
    instance: options.instance,
    location: options.location,
    databaseHost,
    projectId,
  };
  if (options.storageBucket !== undefined) {
    envOptions.storageBucket = options.storageBucket;
  }
  const childEnv = buildFunctionsChildEnv(envOptions);

  // New per spawn: only this host's proxy can reach this child's HTTP listener.
  const httpToken = createChildToken();
  const nodeExecutable = options.nodeExecutable ?? 'node';
  const spawnEnv: NodeJS.ProcessEnv = { ...childEnv };
  spawnEnv[CHILD_TOKEN_ENV] = httpToken;
  const child = spawn(nodeExecutable, [childModulePath], {
    cwd: options.cwd,
    env: spawnEnv,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  let readySettled = false;
  let stopping = false;
  let watchdog: HeartbeatWatch | undefined;
  const heartbeatFloorMs = options.heartbeatTimeoutMs ?? HEARTBEAT_FLOOR_MS;
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-8_192);
  });

  const { promise: ready, resolve: resolveReady, reject: rejectReady } =
    Promise.withResolvers<FunctionsChildReady>();

  child.on('message', (raw: unknown) => {
    if (!isChildMessage(raw)) return;
    if (raw.type === 'heartbeat') {
      watchdog?.beat();
    } else if (raw.type === 'ready') {
      readySettled = true;
      watchdog = watchHeartbeat({
        limitMs: heartbeatLimitMs(raw.http, heartbeatFloorMs, raw.eventTimeouts),
        onSilent: () => options.onUnresponsive?.(),
        isStopping: () => stopping,
      });
      const readyPayload: FunctionsChildReady = {
        triggerCount: raw.triggerCount,
        unsupportedTriggers: raw.unsupportedTriggers,
      };
      if (raw.http !== undefined) {
        readyPayload.http = { ...raw.http, token: httpToken };
      }
      resolveReady(readyPayload);
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
      watchdog?.stop();
      let exitCode = 0;
      if (typeof code === 'number') {
        exitCode = code;
      } else if (signal) {
        exitCode = 1;
      }
      if (!readySettled) {
        readySettled = true;
        const diagnostic = stderr.trim();
        let suffix = '';
        if (diagnostic.length > 0) {
          suffix = `\n${diagnostic}`;
        }
        rejectReady(new Error(
          `Functions RTDB child exited before ready (code ${exitCode})${suffix}`,
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
