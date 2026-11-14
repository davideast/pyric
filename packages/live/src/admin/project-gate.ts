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
import { liveAdminAppUnreadable, liveAdminProjectRefusal, type AdminProjectSource, type LiveAdminProjectRefusal } from '../refusal.js';

type Env = Readonly<Record<string, string | undefined>>;

/** The variables firebase-admin reads a project id from, in its order. */
const PROJECT_VARIABLES = ['GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT'] as const;

/**
 * Inherited environment variable pinning the root `@pyric/live/register`
 * process's resolved `projectId` across child processes and `Worker` threads.
 */
export const LIVE_PINNED_PROJECT_VARIABLE = 'PYRIC_LIVE_HOST_PROJECT';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Reads the pinned live project id inherited from the parent process, if set. */
export function pinnedLiveProjectId(env: Env = process.env): string | undefined {
  const pinned = env[LIVE_PINNED_PROJECT_VARIABLE];
  return isNonEmptyString(pinned) ? pinned : undefined;
}

/** The `projectId` in `FIREBASE_CONFIG`'s inline JSON, or null. */
function firebaseConfigProjectId(config: string | undefined): string | null {
  const isInlineJson = config?.trimStart().startsWith('{') === true;
  if (!isInlineJson) return null;
  try {
    const parsed = JSON.parse(config as string) as { projectId?: unknown };
    return isNonEmptyString(parsed.projectId) ? parsed.projectId : null;
  } catch {
    return null;
  }
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

/** Each project the environment names, with the variable that names it, `FIREBASE_CONFIG` included. */
function envProjects(env: Env): readonly { source: AdminProjectSource; projectId: string }[] {
  const named = projectVariables(env);
  const configProjectId = firebaseConfigProjectId(env.FIREBASE_CONFIG);
  if (configProjectId !== null) named.push({ source: 'FIREBASE_CONFIG', projectId: configProjectId });
  return named;
}

/**
 * The start refusal for the first project variable in `env` that names
 * another project than `hostProjectId`, or null when each set one names it.
 * The register throws it, as it throws `liveStartRefusal`'s reason.
 */
export function adminEnvRefusal(env: Env, hostProjectId: string): LiveAdminProjectRefusal | null {
  const mismatch = envProjects(env).find(({ projectId }) => projectId !== hostProjectId);
  if (mismatch === undefined) return null;
  return liveAdminProjectRefusal({ source: mismatch.source, appProjectId: mismatch.projectId, hostProjectId });
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
