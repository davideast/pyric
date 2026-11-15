/**
 * The Admin project gate: firebase-admin under `@pyric/live/register` only
 * reaches the live host's project.
 *
 * - At register start, the project environment variables firebase-admin
 *   reads (`GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT` and the `projectId` in
 *   `FIREBASE_CONFIG`) must each name the host's project when set
 *   ({@link adminEnvRefusal}).
 * - Per Admin app, before its first call: the project firebase-admin itself
 *   resolves must be the host's ({@link adminProjectGate}). On a mismatch
 *   every call from that app rejects with `PYRIC_LIVE_REFUSED` before the
 *   wrapped call runs, and the process gets one line.
 *
 * Pyric never opens a credentials file and never touches a key or a token:
 * it reads only the project id, through firebase-admin's own objects.
 */
import { readFileSync, statSync } from 'node:fs';
import {
  LIVE_REFUSED,
  liveAdminAppUnreadable,
  liveAdminProjectRefusal,
  type AdminProjectSource,
  type LiveAdminProjectRefusal,
} from '../refusal.js';

type Env = Readonly<Record<string, string | undefined>>;

/** The variables firebase-admin reads a project id from, in its order. */
const PROJECT_VARIABLES = ['GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT'] as const;
const MAX_FIREBASE_CONFIG_BYTES = 1_048_576;
const FIREBASE_CONFIG_BUCKET = /^(?:gs:\/\/)?([a-z0-9-]+)\.(?:appspot\.com|firebasestorage\.app)\/?$/i;
const FIREBASE_CONFIG_DATABASE = /^https?:\/\/([a-z0-9-]+)-default-rtdb\.(?:firebaseio\.com|[a-z0-9-]+\.firebasedatabase\.app)(?:\/|$)/i;

/**
 * Inherited environment variable pinning the root `@pyric/live/register`
 * process's resolved `projectId` across child processes and `Worker` threads.
 */
export const LIVE_PINNED_PROJECT_VARIABLE = 'PYRIC_LIVE_HOST_PROJECT';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function pinnedLiveProjectId(env: Env = process.env): string | undefined {
  const pinned = env[LIVE_PINNED_PROJECT_VARIABLE];
  return isNonEmptyString(pinned) ? pinned : undefined;
}

/**
 * Resolves the live project id for a child process or worker: prefers the
 * parent-pinned project id, falling back to `readLocalProject(projectRoot)`
 * while ignoring caller-mutated `PYRIC_PROJECT` when `ignoreEnvProject` is set.
 */
export function resolveInheritedLiveProject(
  projectRoot: string,
  ignoreEnvProject: boolean,
  readLocalProject: (root: string) => string,
): string | undefined {
  const pinned = pinnedLiveProjectId(process.env);
  if (pinned !== undefined) return pinned;
  const previousPyricProject = process.env.PYRIC_PROJECT;
  if (ignoreEnvProject) delete process.env.PYRIC_PROJECT;
  try {
    return readLocalProject(projectRoot);
  } catch {
    return undefined;
  } finally {
    if (ignoreEnvProject && previousPyricProject !== undefined) {
      process.env.PYRIC_PROJECT = previousPyricProject;
    }
  }
}

export interface LiveProcessPinKeys {
  readonly projectRootVar: string;
  readonly sdkRootVar: string;
  readonly passThroughVar: string;
}

/** Builds the canonical 5-key inherited variable map pinned across children and workers. */
export function buildPinnedLiveEnvMap(
  keys: LiveProcessPinKeys,
  projectRoot: string,
  fallbackSdkRoot: string,
  projectId: string,
): Record<string, string> {
  return {
    [keys.projectRootVar]: projectRoot,
    [keys.sdkRootVar]: process.env[keys.sdkRootVar] ?? fallbackSdkRoot,
    [keys.passThroughVar]: process.env[keys.passThroughVar] ?? '',
    [LIVE_PINNED_PROJECT_VARIABLE]: projectId,
    PYRIC_PROJECT: projectId,
  };
}

function unreadableFirebaseConfigRefusal(hostProjectId: string, reason: string): LiveAdminProjectRefusal {
  const message =
    `@pyric/live: firebase-admin is refused in live mode, from a Node process: ` +
    `the environment variable FIREBASE_CONFIG could not be read (${reason}), so live mode can't verify it targets '${hostProjectId}'. ` +
    `No Admin request left. Fix or unset FIREBASE_CONFIG so it names '${hostProjectId}'.`;
  return Object.assign(new Error(message), {
    code: LIVE_REFUSED,
    source: 'FIREBASE_CONFIG' as const,
    appProjectId: '',
    hostProjectId,
  });
}

function loadFirebaseConfigJson(
  config: string,
  hostProjectId: string,
): { ok: true; text: string } | { ok: false; refusal: LiveAdminProjectRefusal } {
  // Matches firebase-admin's parseFirebaseConfig(): inline JSON starts with '{', otherwise a file path.
  if (config.startsWith('{')) {
    return { ok: true, text: config };
  }
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(config);
  } catch {
    return { ok: false, refusal: unreadableFirebaseConfigRefusal(hostProjectId, 'file could not be read') };
  }
  if (!stats.isFile()) {
    return { ok: false, refusal: unreadableFirebaseConfigRefusal(hostProjectId, 'path is not a regular file') };
  }
  if (stats.size > MAX_FIREBASE_CONFIG_BYTES) {
    return { ok: false, refusal: unreadableFirebaseConfigRefusal(hostProjectId, 'file exceeds size limit') };
  }
  try {
    return { ok: true, text: readFileSync(config, 'utf8') };
  } catch {
    return { ok: false, refusal: unreadableFirebaseConfigRefusal(hostProjectId, 'file could not be read') };
  }
}

function firebaseConfigProjects(parsed: Record<string, unknown>): readonly string[] {
  const found: string[] = [];
  if (isNonEmptyString(parsed.projectId)) found.push(parsed.projectId);
  if (isNonEmptyString(parsed.storageBucket)) {
    const bucketProject = FIREBASE_CONFIG_BUCKET.exec(parsed.storageBucket.trim())?.[1]?.toLowerCase();
    if (bucketProject !== undefined) found.push(bucketProject);
  }
  if (isNonEmptyString(parsed.databaseURL)) {
    const dbProject = FIREBASE_CONFIG_DATABASE.exec(parsed.databaseURL.trim())?.[1]?.toLowerCase();
    if (dbProject !== undefined) found.push(dbProject);
  }
  return found;
}

/**
 * Validates `FIREBASE_CONFIG` (inline JSON or file path, matching firebase-admin)
 * against `hostProjectId`, failing closed when set but unreadable or malformed.
 */
function firebaseConfigRefusal(config: string | undefined, hostProjectId: string): LiveAdminProjectRefusal | null {
  if (!isNonEmptyString(config)) return null;
  const loaded = loadFirebaseConfigJson(config, hostProjectId);
  if (!loaded.ok) return loaded.refusal;
  let parsed: unknown;
  try {
    parsed = JSON.parse(loaded.text);
  } catch {
    return unreadableFirebaseConfigRefusal(hostProjectId, 'invalid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return unreadableFirebaseConfigRefusal(hostProjectId, 'expected a JSON object');
  }
  const mismatch = firebaseConfigProjects(parsed as Record<string, unknown>).find((id) => id !== hostProjectId);
  if (mismatch === undefined) return null;
  return liveAdminProjectRefusal({ source: 'FIREBASE_CONFIG', appProjectId: mismatch, hostProjectId });
}

/**
 * The projects `GOOGLE_CLOUD_PROJECT` and `GCLOUD_PROJECT` name, in that
 * order: the variables firebase-admin reads for an app with explicit
 * options. It reads `FIREBASE_CONFIG` only when `initializeApp()` gets no
 * options, and then its project is already `options.projectId`.
 */
function projectVariables(env: Env): { source: AdminProjectSource; projectId: string }[] {
  const named: { source: AdminProjectSource; projectId: string }[] = [];
  for (const variable of PROJECT_VARIABLES) {
    const projectId = env[variable];
    if (isNonEmptyString(projectId)) named.push({ source: variable, projectId });
  }
  return named;
}

/**
 * The start refusal for the first project variable in `env` that names
 * another project than `hostProjectId` (or an unreadable/malformed
 * `FIREBASE_CONFIG`), or null when each set one names it.
 * The register throws it, as it throws `liveStartRefusal`'s reason.
 */
export function adminEnvRefusal(env: Env, hostProjectId: string): LiveAdminProjectRefusal | null {
  const mismatch = projectVariables(env).find(({ projectId }) => projectId !== hostProjectId);
  if (mismatch !== undefined) {
    return liveAdminProjectRefusal({ source: mismatch.source, appProjectId: mismatch.projectId, hostProjectId });
  }
  return firebaseConfigRefusal(env.FIREBASE_CONFIG, hostProjectId);
}

/** The project an Admin app resolves, and where it came from. */
export interface AdminAppProject {
  readonly source: AdminProjectSource;
  readonly projectId: string;
}

/** A credential's own project accessors: `cert()`'s `projectId`, ADC's `getProjectId()`. */
interface ProjectCredential {
  readonly projectId?: unknown;
  readonly getProjectId?: () => Promise<unknown>;
}

/**
 * The part of a firebase-admin `App` the gate reads: its options. Typed here
 * so `@pyric/live` takes no type dependency on firebase-admin.
 */
export interface AdminApp {
  readonly options: { readonly projectId?: string; readonly credential?: object };
}

/**
 * The project `app` resolves, in firebase-admin's own order: its
 * `options.projectId`, its credential's `projectId` (a `cert()` credential),
 * `GOOGLE_CLOUD_PROJECT` or `GCLOUD_PROJECT`, then its credential's
 * `getProjectId()` (application default credentials). Null when none names
 * one; rejects with `getProjectId()`'s error when it throws.
 */
export async function adminAppProjectId(app: AdminApp, env: Env = process.env): Promise<AdminAppProject | null> {
  if (isNonEmptyString(app.options.projectId)) return { source: 'options.projectId', projectId: app.options.projectId };
  const credential = app.options.credential as ProjectCredential | undefined;
  if (isNonEmptyString(credential?.projectId)) return { source: 'credential', projectId: credential.projectId };
  const fromEnv = projectVariables(env)[0];
  if (fromEnv !== undefined) return fromEnv;
  const resolved = await credential?.getProjectId?.();
  return isNonEmptyString(resolved) ? { source: 'credential', projectId: resolved } : null;
}

/** Runs `call` for `app` once its project passes the gate; rejects with the refusal otherwise. */
export type AdminProjectGate = <T>(app: AdminApp, call: () => T | Promise<T>) => Promise<T>;

/** Stands in for an app a row can't read; {@link failClosedGate} refuses it. */
export const UNREAD_APP: AdminApp = Object.freeze({ options: {} });

/**
 * The app `self` keeps at `field`, or {@link UNREAD_APP} when it keeps none
 * there that has `options`, as after a firebase-admin upgrade that moves it.
 */
export function readAdminApp(self: unknown, field: string): AdminApp {
  const app: unknown = typeof self === 'object' && self !== null ? Reflect.get(self, field) : undefined;
  const hasOptions = typeof app === 'object' && app !== null && typeof Reflect.get(app, 'options') === 'object';
  return hasOptions ? (app as AdminApp) : UNREAD_APP;
}

/** `gate`, except that a call on {@link UNREAD_APP} is refused with `liveAdminAppUnreadable(className)`. */
export function failClosedGate(gate: AdminProjectGate, className: string): AdminProjectGate {
  return (app, call) => (app === UNREAD_APP ? Promise.reject(liveAdminAppUnreadable(className)) : gate(app, call));
}

/**
 * The gate for the live host's `hostProjectId`. Each app's project is
 * resolved once, before its first call. An app on another project gets the
 * refusal from every call, and `write` gets one line for the process, at the
 * first refusal. An app whose `getProjectId()` throws, such as one on
 * application default credentials with no project, rejects every call with
 * that error. An app that resolves no project runs.
 */
export function adminProjectGate(hostProjectId: string, write: (line: string) => void, env: Env = process.env): AdminProjectGate {
  const checks = new WeakMap<AdminApp, Promise<LiveAdminProjectRefusal | null>>();
  let hasWritten = false;
  const check = async (app: AdminApp): Promise<LiveAdminProjectRefusal | null> => {
    const resolved = await adminAppProjectId(app, env);
    const matches = resolved === null || resolved.projectId === hostProjectId;
    if (matches) return null;
    const refusal = liveAdminProjectRefusal({ source: resolved.source, appProjectId: resolved.projectId, hostProjectId });
    if (!hasWritten) write(refusal.message);
    hasWritten = true;
    return refusal;
  };
  return async (app, call) => {
    let pending = checks.get(app);
    if (pending === undefined) {
      pending = check(app);
      checks.set(app, pending);
    }
    const refusal = await pending;
    if (refusal !== null) throw refusal;
    return call();
  };
}
