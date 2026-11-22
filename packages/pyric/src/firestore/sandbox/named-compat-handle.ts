/**
 * Scoped `SandboxContext` adapter for named Firestore databases.
 *
 * Uses the `Symbol.for('pyric.sandbox.internalEnv')` seam on `getInternalEnv`
 * so `getChainableFirestore`, `getChainableAdminFirestore`, and chainable
 * `.onSnapshot` listeners operate against the named database's
 * `LocalEnvironment` while preserving provenance and error translation.
 */
import { SandboxContextImpl, type Sandbox, type SandboxContext } from 'pyric/sandbox';
import { bindOperationContext } from 'pyric/sandbox/internal';
import {
  getAdminFirestore as getChainableAdminFirestore,
  getFirestore as getChainableFirestore,
  type SandboxFirestore,
} from 'pyric/sandbox/admin-firestore';
import type { LocalEnvironment } from './local-environment.js';
import {
  DEFAULT_FIRESTORE_DATABASE,
  getAdminHandleEnv,
  getClientHandleEnv,
  isFirestoreDatabaseDeclared,
  normalizeFirestoreDatabaseId,
} from './named-databases.js';

const SANDBOX_ENV = Symbol.for('pyric.sandbox.internalEnv');

const clientScopedSandboxViews = new WeakMap<Sandbox, Map<string, Sandbox>>();
const adminScopedSandboxViews = new WeakMap<Sandbox, Map<string, Sandbox>>();

function createScopedSandboxProxy(
  sandbox: Sandbox,
  resolveEnv: () => LocalEnvironment,
): Sandbox {
  const target = Object.create(null) as Record<PropertyKey, unknown>;
  return new Proxy(target, {
    get(_unused, prop) {
      if (prop === SANDBOX_ENV) {
        return resolveEnv;
      }
      const value = Reflect.get(sandbox as object, prop, sandbox as object);
      if (typeof value === 'function') {
        return (value as (...args: unknown[]) => unknown).bind(sandbox);
      }
      return value;
    },
    has(_unused, prop) {
      if (prop === SANDBOX_ENV) return true;
      return prop in (sandbox as object);
    },
  }) as unknown as Sandbox;
}

function getScopedSandboxView(
  sandbox: Sandbox,
  databaseId: string,
  strictDeclared: boolean,
): Sandbox {
  const cacheRoot = strictDeclared ? adminScopedSandboxViews : clientScopedSandboxViews;
  let perDb = cacheRoot.get(sandbox);
  if (perDb === undefined) {
    perDb = new Map();
    cacheRoot.set(sandbox, perDb);
  }
  const existing = perDb.get(databaseId);
  if (existing !== undefined) {
    return existing;
  }
  let resolveEnv: () => LocalEnvironment;
  if (strictDeclared) {
    resolveEnv = () => getAdminHandleEnv(sandbox, databaseId);
  } else {
    resolveEnv = () => getClientHandleEnv(sandbox, databaseId);
  }
  const created = createScopedSandboxProxy(sandbox, resolveEnv);
  if (isFirestoreDatabaseDeclared(sandbox, databaseId)) {
    perDb.set(databaseId, created);
  }
  return created;
}

function deriveScopedContext(
  ctx: SandboxContext,
  databaseId: string,
  strictDeclared: boolean,
): SandboxContext {
  const scopedSandbox = getScopedSandboxView(ctx.sandbox, databaseId, strictDeclared);
  const raw = new SandboxContextImpl(scopedSandbox, ctx.auth);
  return bindOperationContext(raw, ctx.operationContext);
}

/** Resolve a rules-enforced `SandboxFirestore` handle for `databaseId`. */
export function getDatabaseChainableFirestore(
  ctx: SandboxContext,
  databaseId?: string,
): SandboxFirestore {
  const normalized = normalizeFirestoreDatabaseId(databaseId);
  if (normalized === DEFAULT_FIRESTORE_DATABASE) {
    return getChainableFirestore(ctx);
  }
  return getChainableFirestore(deriveScopedContext(ctx, normalized, false));
}

/** Resolve a rules-bypassing `SandboxFirestore` handle for `databaseId` (strictly requires declaration). */
export function getDatabaseChainableAdminFirestore(
  ctx: SandboxContext,
  databaseId?: string,
): SandboxFirestore {
  const normalized = normalizeFirestoreDatabaseId(databaseId);
  if (normalized === DEFAULT_FIRESTORE_DATABASE) {
    return getChainableAdminFirestore(ctx);
  }
  return getChainableAdminFirestore(deriveScopedContext(ctx, normalized, true));
}
