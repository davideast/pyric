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
 * the same entry, as the production SDK resolves `getDatabase(app)` and that
 * URL to one instance. So does `<projectId>`, the default instance of a
 * project created before about 2020 (`https://<projectId>.firebaseio.com`).
 */

import {
  getDatabase as pyricGetDatabase,
  getAdminDatabase as pyricGetAdminDatabase,
  sandbox as rtdbSandbox,
  type Database,
} from 'pyric/database';
import {
  createDatabaseInstanceRegistry,
  LOCKED_DATABASE_RULES,
  UNNAMED_DEFAULT_DATABASE_INSTANCE,
  databaseInstanceNamed,
  defaultDatabaseInstanceName,
  isDefaultDatabaseInstance,
  undeployedInstanceNotice,
  type DatabaseInstanceRegistry,
} from 'pyric/sandbox/internal';
import type { AuthLens } from 'pyric/sandbox';

import type { HostCtx, HostRtdbInstance, PortLike } from '../host-context.js';
import { portSession } from '../host-auth.js';
import { defaultInstanceDeploy, twoDefaultRulesFilesMessage } from '../../database-instance-rules-host.js';
import { authStateForLens, lensCacheKey, sessionCacheKey } from './core.js';

/** The project id the host serves: the server's, else the first app port's. */
export function hostProjectId(ctx: HostCtx): string | undefined {
  if (ctx.rtdbProjectId) return ctx.rtdbProjectId;
  const fromApp = ctx.appOptions?.projectId;
  return typeof fromApp === 'string' && fromApp.length > 0 ? fromApp : undefined;
}

/** The default instance's name, when known: the project config's, else the app's project default. */
export function defaultInstanceNameOf(ctx: HostCtx): string | undefined {
  if (ctx.defaultRtdbInstance) return ctx.defaultRtdbInstance;
  const projectId = hostProjectId(ctx);
  return projectId === undefined ? undefined : defaultDatabaseInstanceName(projectId);
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
      // The default instance's policy and rules are set with the project's
      // rules. Until rules are deployed to it, every other instance starts
      // locked, as production creates a new instance, or open in permissive
      // mode, as the default instance is.
      if (selector !== undefined) {
        const policy = ctx.rtdbDefaultPolicy ?? 'deny';
        rtdbSandbox.setDefaultPolicy(live, policy);
        rtdbSandbox.setRules(live, policy === 'allow' ? null : LOCKED_DATABASE_RULES);
      }
      return { key, selector, live, sessions: new Map(), lenses: new Map() };
    },
  });
  ctx.rtdbInstances = registry;
  return registry;
}

/**
 * The registry key for an instance name; `undefined` is the default instance.
 * Throws the SDK's URL error for an invalid name.
 */
export function rtdbInstanceKey(ctx: HostCtx, name?: string): string {
  const registry = rtdbInstances(ctx);
  // The config's default name may be the unnamed default key when no project
  // id is known, so it is matched before it is parsed as an instance name.
  if (name === undefined || name === ctx.defaultRtdbInstance || name === UNNAMED_DEFAULT_DATABASE_INSTANCE) return registry.defaultKey;
  const instance = databaseInstanceNamed(name);
  const isDefault = instance.name === defaultInstanceNameOf(ctx) || isDefaultDatabaseInstance(instance.name, hostProjectId(ctx));
  if (isDefault) return registry.defaultKey;
  return registry.keyOf(instance);
}

/** The host's entry for an instance name; `undefined` is the default instance. */
export function rtdbInstance(ctx: HostCtx, name?: string): HostRtdbInstance {
  return rtdbInstances(ctx).getOrCreate(rtdbInstanceKey(ctx, name));
}

/**
 * Adopt the default instance's name once the first app port names its
 * project. Without `.firebaserc` or `--project`, `firebase.json` rules for
 * `<projectId>-default-rtdb` or `<projectId>` were deployed before the host
 * knew those names are the default instance's; they move to the default
 * instance, which `getDatabase(app)` reads and writes. Rules for both names
 * from different sources are refused, as `firebase.json` is refused when the
 * project is known at startup: the default instance is locked and the error
 * names both files.
 */
export function adoptAppDefaultRtdbInstance(ctx: HostCtx): void {
  const projectId = ctx.appOptions?.projectId;
  const knowsDefault = ctx.defaultRtdbInstance !== undefined && ctx.defaultRtdbInstance !== UNNAMED_DEFAULT_DATABASE_INSTANCE;
  if (typeof projectId !== 'string' || projectId.length === 0 || knowsDefault) return;
  const name = defaultDatabaseInstanceName(projectId);
  const registry = ctx.rtdbInstances;
  if (registry !== undefined) adoptDefaultEntries(ctx, registry, projectId);
  ctx.defaultRtdbInstance = name;
}

type DeployedRules = NonNullable<HostRtdbInstance['rules']>;

/** Move the rules held under either name of the project's default instance to it, and forget those entries. */
function adoptDefaultEntries(ctx: HostCtx, registry: DatabaseInstanceRegistry<HostRtdbInstance>, projectId: string): void {
  const [first, ...others] = takeDefaultEntries(registry, projectId);
  if (first === undefined) return;
  const fallback = registry.getOrCreate(registry.defaultKey);
  const conflicting = others.find((other) => JSON.stringify(other.rules.source) !== JSON.stringify(first.rules.source));
  if (conflicting !== undefined) {
    const files = ctx.rtdbRulesFiles;
    const text = twoDefaultRulesFilesMessage(
      defaultDatabaseInstanceName(projectId),
      projectId,
      defaultInstanceDeploy(first.name, files),
      defaultInstanceDeploy(conflicting.name, files),
    );
    console.error(`[pyric] ${text}`);
    rtdbSandbox.setRules(fallback.live, LOCKED_DATABASE_RULES);
    fallback.rules = { source: LOCKED_DATABASE_RULES, updatedAt: Date.now(), status: 'error', messages: [{ severity: 'error', text }] };
    return;
  }
  const deployed = first.rules;
  const enforced = deployed.status === 'active' ? deployed.source : deployed.lastKnownGood ?? null;
  rtdbSandbox.setRules(fallback.live, enforced as { rules: Record<string, unknown> } | null);
  fallback.rules = deployed;
}

/** Remove the entries named by either name of the default instance; returns the rules they held. */
function takeDefaultEntries(
  registry: DatabaseInstanceRegistry<HostRtdbInstance>,
  projectId: string,
): Array<{ name: string; rules: DeployedRules }> {
  const taken: Array<{ name: string; rules: DeployedRules }> = [];
  for (const name of [defaultDatabaseInstanceName(projectId), projectId]) {
    const entry = name === registry.defaultKey ? undefined : registry.get(name);
    if (entry === undefined) continue;
    registry.delete(name);
    if (entry.rules !== undefined) taken.push({ name, rules: entry.rules });
  }
  return taken;
}

/** Log, once per instance, how an instance without deployed rules is served. */
function noticeUndeployedInstance(ctx: HostCtx, entry: HostRtdbInstance): void {
  const isUndeployed = entry.selector !== undefined && entry.rules === undefined;
  if (!isUndeployed || entry.noticed) return;
  entry.noticed = true;
  console.warn(undeployedInstanceNotice(entry.key, ctx.rtdbDefaultPolicy ?? 'deny'));
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
  noticeUndeployedInstance(ctx, entry);
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
