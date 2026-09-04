import type { Sandbox, SandboxContext } from 'pyric/sandbox';
import { SandboxContextImpl } from 'pyric/sandbox';
import type { FirebaseApp } from '../app/types.js';
import { defaultClientApp, resolveClientApp } from '../sandbox/internal/client-app.js';
import { canonicalizeDatabaseUrl, getOrCreateBackend } from './sandbox/backend-for.js';
import { RtdbConnectionLifecycle } from './connection-lifecycle.js';
import { TARGET_SYMBOL, type SandboxLiveTarget, type SandboxTarget } from './routing.js';
import { Database, type AppDatabase } from './types.js';

// ─── Constructors ────────────────────────────────────────────────────

/**
 * Build a sandbox Database handle:
 *
 *   - `SandboxContext` → sandbox-backed, frozen identity.
 *   - `Sandbox` → sandbox-backed, live identity (per-op `currentUser`).
 * @example
 * ```ts
 * import { initializeSandbox } from 'pyric/sandbox';
 * import { getDatabase, ref, set, get } from 'pyric/database';
 *
 * const sandbox = initializeSandbox();
 * const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
 * await set(ref(db, 'greetings/hello'), { text: 'hi' });
 * const snap = await get(ref(db, 'greetings/hello'));
 * console.log(snap.val()); // { text: 'hi' }
 * ```
 */
export function getDatabase(ctx: SandboxContext, url?: string): Database;
export function getDatabase(sandbox: Sandbox, url?: string): Database;
export function getDatabase(app: FirebaseApp, url?: string): AppDatabase;
export function getDatabase(url?: string): AppDatabase;
export function getDatabase(
  targetOrUrl?: SandboxContext | Sandbox | FirebaseApp | string,
  url?: string,
): Database {
  let target = targetOrUrl;
  let effectiveUrl: string | undefined = url;

  if (typeof targetOrUrl === 'string') {
    target = defaultClientApp() as FirebaseApp;
    effectiveUrl = targetOrUrl;
  } else if (target === undefined) {
    target = defaultClientApp() as FirebaseApp;
  }

  // Package resolution already selected the sandbox mirror; the neutral app
  // adapter resolves an associated FirebaseApp to its app-owned runtime.
  const appRuntime = resolveClientApp(target);
  if (appRuntime) {
    const app = target as FirebaseApp;
    let appDbUrl: string | undefined;
    try {
      appDbUrl = app.options?.databaseURL;
    } catch {
      // If app is already deleted, reading app.options throws app/app-deleted.
    }
    const finalUrl = effectiveUrl ?? appDbUrl;
    const canonicalKey = canonicalizeDatabaseUrl(finalUrl);

    return appRuntime.service(`database/${canonicalKey}`, () => {
      const { sandbox, session } = appRuntime;
      let deleted = false;
      appRuntime.onDelete(() => { deleted = true; });
      const backend = getOrCreateBackend(sandbox, finalUrl);
      const connection = new RtdbConnectionLifecycle(
        backend,
        () => session.currentUser,
        false,
      );
      appRuntime.onDelete(() => connection.drain().catch(() => undefined));
      const t: SandboxLiveTarget = {
        kind: 'sandbox-live',
        backend,
        connection,
        sandbox,
        currentUser: () => session.currentUser,
        onCurrentUserChanged: (callback) => session.onCurrentUserChanged(callback),
        own: (cleanup) => appRuntime.onDelete(cleanup),
        assertUsable: () => {
          if (deleted) {
            throw new Error('FIREBASE FATAL ERROR: Cannot call ref on a deleted database. ');
          }
        },
      };
      return new Database(t, app) as AppDatabase;
    });
  }

  if (isSandboxContext(target)) {
    const backend = getOrCreateBackend(target.sandbox, effectiveUrl);
    const connection = new RtdbConnectionLifecycle(backend, () => target.auth, false);
    const t: SandboxTarget = { kind: 'sandbox', backend, auth: target.auth, connection };
    return new Database(t);
  }

  if (isSandbox(target)) {
    const backend = getOrCreateBackend(target, effectiveUrl);
    const connection = new RtdbConnectionLifecycle(
      backend,
      () => target.currentUser,
      false,
    );
    const t: SandboxLiveTarget = {
      kind: 'sandbox-live',
      backend,
      connection,
      sandbox: target,
      onCurrentUserChanged: (callback) => target.onCurrentUserChanged(callback),
    };
    return new Database(t);
  }

  throw packageResolutionError();
}

/**
 * Sandbox-only rules-bypass RTDB handle. Mirrors Firestore's
 * `getAdminFirestore(sandbox)` for Studio/Playground data browsers and
 * controlled admin tools.
 */
export function getAdminDatabase(sandbox: Sandbox, url?: string): Database;
export function getAdminDatabase(ctx: SandboxContext, url?: string): Database;
export function getAdminDatabase(app: FirebaseApp, url?: string): Database;
export function getAdminDatabase(
  target: Sandbox | SandboxContext | FirebaseApp,
  url?: string,
): Database {
  const appRuntime = resolveClientApp(target);
  if (appRuntime) {
    appRuntime.assertAlive();
    const effectiveUrl = url ?? (target as FirebaseApp).options?.databaseURL;
    return getAdminDatabase(appRuntime.sandbox, effectiveUrl);
  }
  const sandbox = isSandboxContext(target)
    ? target.sandbox
    : isSandbox(target)
      ? target
      : undefined;
  if (sandbox === undefined) throw packageResolutionError();
  const backend = getOrCreateBackend(sandbox, url);
  const connection = new RtdbConnectionLifecycle(backend, () => null, true);
  const t: SandboxTarget = { kind: 'sandbox', backend, auth: null, admin: true, connection };
  return new Database(t);
}

function packageResolutionError(): TypeError {
  return new TypeError(
    'pyric/database is a sandbox-only mirror. Package resolution must leave firebase/database unchanged for production; activate pyric sandbox or @pyric/cli/register before importing to select the sandbox.',
  );
}

function isSandboxContext(
  target: unknown,
): target is SandboxContext {
  return target instanceof SandboxContextImpl;
}

function isSandbox(
  target: unknown,
): target is Sandbox {
  if (target === null || typeof target !== 'object') return false;
  const o = target as unknown as Record<string, unknown>;
  return (
    typeof o.withAuth === 'function'
    && typeof o.onCurrentUserChanged === 'function'
    && 'currentUser' in o
    && 'admin' in o
  );
}
