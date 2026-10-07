/**
 * SharedWorker and Node host: the RTDB instances the host serves.
 *
 * Production gives each database URL its own instance with its own data and
 * rules, all authenticated by the project's one Auth. The host holds one
 * entry per instance name: a separate sandbox store, the handles every auth
 * lens resolves to, and the instance's deployed rules. The sandbox's Auth
 * session pool is shared, so one signed-in port's identity reaches every
 * instance.
 *
 * An operation names its instance with the protocol's `instance` field; an
 * absent field is the default instance. The default instance's name,
 * `<projectId>-default-rtdb` or the name `firebase.json` gives it, resolves to
 * the same entry, as the production
 * SDK resolves `getDatabase(app)` and that URL to one instance.
 */

import {
  getDatabase as pyricGetDatabase,
  getAdminDatabase as pyricGetAdminDatabase,
  sandbox as rtdbSandbox,
  type Database,
} from 'pyric/database';
import {
  createDatabaseInstanceRegistry,
  databaseInstanceNamed,
  defaultDatabaseInstanceName,
  type DatabaseInstanceRegistry,
} from 'pyric/sandbox/internal';
import type { AuthLens } from 'pyric/sandbox';

import { RTDB_UNKNOWN_INSTANCE_CODE } from '../protocol.js';
import type { HostCtx, HostRtdbInstance, PortLike } from '../host-context.js';
import { portSession } from '../host-auth.js';
import { authStateForLens, lensCacheKey, sessionCacheKey } from './core.js';

/** The default instance's name, when known: the project config's, else the app's project default. */
function defaultInstanceNameOf(ctx: HostCtx): string | undefined {
  if (ctx.defaultRtdbInstance) return ctx.defaultRtdbInstance;
  const fromApp = ctx.appOptions?.projectId;
  return typeof fromApp === 'string' && fromApp.length > 0 ? defaultDatabaseInstanceName(fromApp) : undefined;
}

/** The host's instance registry, created on first use. */
export function rtdbInstances(ctx: HostCtx): DatabaseInstanceRegistry<HostRtdbInstance> {
  if (ctx.rtdbInstances) return ctx.rtdbInstances;
  const defaultName = defaultInstanceNameOf(ctx);
  const registry: DatabaseInstanceRegistry<HostRtdbInstance> = createDatabaseInstanceRegistry({
    defaultName,
    create: (key) => {
      const selector = key === registry.defaultKey ? undefined : key;
      const live = pyricGetDatabase(ctx.sandbox, selector);
      // The default instance's policy is set with the project's rules; every
      // other instance starts with the host's policy for unconfigured rules.
      if (selector !== undefined) rtdbSandbox.setDefaultPolicy(live, ctx.rtdbDefaultPolicy ?? 'deny');
      return { key, selector, live, sessions: new Map(), lenses: new Map() };
    },
  });
  ctx.rtdbInstances = registry;
  return registry;
}

/** An error for an instance the project does not declare. */
function unknownInstance(name: string): Error & { code: string } {
  return Object.assign(
    new Error(`The project declares no Realtime Database instance named "${name}". Production serves no such instance.`),
    { code: RTDB_UNKNOWN_INSTANCE_CODE },
  );
}

/**
 * The registry key for an instance name; `undefined` is the default instance.
 * Throws the SDK's URL error for an invalid name, and {@link unknownInstance}
 * for a name the project's declared instances leave out.
 */
export function rtdbInstanceKey(ctx: HostCtx, name?: string): string {
  const registry = rtdbInstances(ctx);
  // The config's default name may be the unnamed default key when no project
  // id is known, so it is matched before it is parsed as an instance name.
  if (name === undefined || name === ctx.defaultRtdbInstance) return registry.defaultKey;
  const instance = databaseInstanceNamed(name);
  const appProject = ctx.appOptions?.projectId;
  const isDefault = instance.name === defaultInstanceNameOf(ctx)
    || (typeof appProject === 'string' && instance.name === defaultDatabaseInstanceName(appProject));
  if (isDefault) return registry.defaultKey;
  const key = registry.keyOf(instance);
  if (key === registry.defaultKey) return key;
  const declared = ctx.declaredRtdbInstances;
  if (declared !== undefined && !declared.has(key)) throw unknownInstance(key);
  return key;
}

/** The host's entry for an instance name; `undefined` is the default instance. */
export function rtdbInstance(ctx: HostCtx, name?: string): HostRtdbInstance {
  return rtdbInstances(ctx).getOrCreate(rtdbInstanceKey(ctx, name));
}

function sessionRtdb(ctx: HostCtx, entry: HostRtdbInstance, port: PortLike): Database {
  const session = portSession(ctx, port);
  if (!session) return entry.live;
  const key = sessionCacheKey(session);
  let handle = entry.sessions.get(key);
  if (!handle) {
    handle = pyricGetDatabase(ctx.sandbox.withAuth(session.state), entry.selector);
    entry.sessions.set(key, handle);
  }
  return handle;
}

/**
 * The handle an RTDB operation on `instance` runs against, given its `actAs`
 * lens. Absent or `app-session` is the port's session, `admin` bypasses rules,
 * `anon` is unauthenticated, and `as` impersonates; see `lensDb` in
 * `host/core.ts` for the lens semantics.
 */
export function lensRtdb(
  ctx: HostCtx,
  actAs: AuthLens | undefined,
  port: PortLike,
  instance?: string,
): Database {
  const entry = rtdbInstance(ctx, instance);
  if (!actAs || actAs.mode === 'app-session') return sessionRtdb(ctx, entry, port);
  if (actAs.mode === 'admin') return (entry.admin ??= pyricGetAdminDatabase(ctx.sandbox, entry.selector));
  if (actAs.mode === 'anon') return (entry.anon ??= pyricGetDatabase(ctx.sandbox.withAuth(null), entry.selector));
  const key = lensCacheKey(actAs);
  let handle = entry.lenses.get(key);
  if (!handle) {
    handle = pyricGetDatabase(ctx.sandbox.withAuth(authStateForLens(actAs)), entry.selector);
    entry.lenses.set(key, handle);
  }
  return handle;
}
