/**
 * `pyric/firestore` — Firestore handle construction.
 *
 * The `getFirestore` / `getAdminFirestore` / `actingAs` entry points that
 * mint a {@link Firestore} handle for a sandbox backend and the private
 * backend-shape predicates they dispatch on.
 */
import {
  getFirestore as getChainableFirestore,
  getAdminFirestore as getChainableAdminFirestore,
  type SandboxFirestore,
} from 'pyric/sandbox/admin-firestore';
import { SandboxContextImpl } from 'pyric/sandbox';
import type { AuthState, Sandbox, SandboxContext } from 'pyric/sandbox';
import { bindOperationContext } from 'pyric/sandbox/internal';
import { getInternalEnv } from '../sandbox/internal/sandbox-impl.js';
import type { FirebaseApp } from 'firebase/app';
import { FirebaseError } from '../sandbox/internal/firebase-error.js';
import {
  defaultClientApp,
  resolveClientApp,
} from '../sandbox/internal/client-app.js';

import {
  TARGET_SYMBOL,
  targetOf,
  type SandboxTarget,
  type SandboxLiveTarget,
} from './state.js';
import type { AppFirestore, Firestore } from './types.js';

/**
 * Construct a Firestore handle. Three overloads dispatch by the
 * input's shape:
 *
 *   - `SandboxContext` → sandbox-backed Firestore with a frozen
 *     identity (the ctx's `auth` chosen at `getFirestore` time). Best
 *     for runner/test code that names identity explicitly per
 *     scenario.
 *   - `Sandbox` → sandbox-backed Firestore that reads
 *     `sandbox.currentUser` per-call. Best for app code that drives
 *     identity through `pyric/auth` — every Firestore op evaluates
 *     rules under whatever user is currently signed in.
 * @example
 * ```ts
 * // Sandbox, frozen identity (runner / explicit tests).
 * import { initializeSandbox } from 'pyric/sandbox';
 * import { getFirestore, doc, setDoc } from 'pyric/firestore';
 * const sandbox = initializeSandbox();
 * const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
 *
 * // Sandbox, live identity (app code paired with pyric/auth).
 * import { initializeSandbox } from 'pyric/sandbox';
 * import { getAuth, signInAnonymously } from 'pyric/auth';
 * const sandbox = initializeSandbox();
 * const auth = getAuth(sandbox);
 * const db = getFirestore(sandbox); // reads sandbox.currentUser per op
 * await signInAnonymously(auth);    // subsequent db ops use the new identity
 *
 * // Canonical imports are swapped to this mirror in a sandbox process.
 * import { initializeApp } from 'firebase/app';
 * import { getFirestore } from 'firebase/firestore';
 * const app = initializeApp({ projectId: 'demo-project' });
 * const db = getFirestore(app);
 * ```
 */
export function getFirestore(ctx: SandboxContext): Firestore;
export function getFirestore(sandbox: Sandbox): Firestore;
export function getFirestore(app: FirebaseApp): AppFirestore;
export function getFirestore(): AppFirestore;
export function getFirestore(target?: SandboxContext | Sandbox | FirebaseApp): Firestore;
export function getFirestore(target?: SandboxContext | Sandbox | FirebaseApp): Firestore {
  if (target === undefined) return getFirestore(defaultClientApp() as FirebaseApp);
  // Package resolution already selected the sandbox mirror before this code
  // loaded, so a recognized FirebaseApp resolves to its private Sandbox.
  const appRuntime = resolveClientApp(target);
  if (appRuntime) {
    return appRuntime.service('firestore/default', () => {
      const { sandbox, session } = appRuntime;
      let terminated = false;
      appRuntime.onDelete(() => { terminated = true; });
      const authScope = appRuntime.authScope;
      if (authScope) {
        appRuntime.onDelete(session.onCurrentUserChanged((user) => {
          getInternalEnv(sandbox).reevaluateLiveListeners(user, authScope);
        }));
      }
      const t: SandboxLiveTarget = {
        kind: 'sandbox-live',
        sandbox,
        getDb: makeGetDb(sandbox, () => session.currentUser),
        authScope,
        own: (cleanup) => appRuntime.onDelete(cleanup),
        assertUsable: () => {
          if (terminated) {
            throw new FirebaseError('failed-precondition', 'The client has already been terminated.');
          }
        },
      };
      return { [TARGET_SYMBOL]: t, app: target as FirebaseApp };
    });
  }
  if (isSandboxContext(target)) {
    const chainable = getChainableFirestore(target);
    const t: SandboxTarget = { kind: 'sandbox', db: chainable, sandbox: target.sandbox };
    return { [TARGET_SYMBOL]: t };
  }
  if (isSandbox(target)) {
    const t: SandboxLiveTarget = {
      kind: 'sandbox-live',
      sandbox: target,
      getDb: makeGetDb(target),
    };
    return { [TARGET_SYMBOL]: t };
  }
  throw new TypeError(
    'pyric/firestore is a sandbox-only mirror. Package resolution must leave firebase/firestore unchanged for production; activate pyric dev or @pyric/cli/register before importing to select the sandbox.',
  );
}

/**
 * A Firestore handle scoped to a specific identity, for multi-user testing.
 *
 * `actingAs(sandbox, { uid })` returns a `Firestore` whose ops evaluate security
 * rules as that user (`request.auth.uid === uid`; custom claims via `token`);
 * `actingAs(sandbox, null)` is the anonymous (signed-out) path. Multiple
 * identities over ONE sandbox share the same store, so a write by one is
 * delivered to another's `onSnapshot`: the basis for multi-user sync testing.
 *
 * @example
 * ```ts
 * import { initializeSandbox } from 'pyric/sandbox';
 * import { actingAs, doc, setDoc, onSnapshot } from 'pyric/firestore';
 * const sandbox = initializeSandbox();
 * const alice = actingAs(sandbox, { uid: 'alice' });
 * const bob   = actingAs(sandbox, { uid: 'bob', token: { role: 'member' } });
 * onSnapshot(doc(bob, 'rooms/r1'), () => {
 *   // fires when alice writes (same store; rules evaluated as bob)
 * });
 * await setDoc(doc(alice, 'rooms/r1'), { owner: 'alice' });
 * ```
 *
 * Thin sugar over `getFirestore(sandbox.withAuth(identity))`; the value is a
 * named, discoverable seam for multi-user scenarios. See
 * the design rationale.
 */
export function actingAs(sandbox: Sandbox, identity: AuthState): Firestore {
  return getFirestore(sandbox.withAuth(identity));
}

/**
 * Construct a **rules-bypassing** sandbox Firestore handle — the Pyric
 * Studio admin lens (Gap #2). Every modular op issued against the returned
 * handle (`getDoc`/`getDocs`/`setDoc`/`updateDoc`/`deleteDoc`/`addDoc`/
 * `count`/`writeBatch`/`runTransaction`) SKIPS security-rule evaluation and
 * is treated as ALLOW, while still going through the same store + emitting
 * the same events + waking the same listeners. This is the modular sibling
 * of the path-string `sandbox.admin.*` bypass; it reuses the underlying
 * `LocalEnvironment` bypass execution path (the `bypassRules` op flag),
 * not a parallel reimplementation.
 *
 * Sandbox-only. There is no prod analog (you cannot bypass deployed
 * security rules from a client), so this overload set accepts only a
 * `Sandbox`, `SandboxContext`, or a privately-associated `FirebaseApp`.
 * Admin ops are identity-agnostic (rules are off), so the
 * handle is a FROZEN `sandbox` target: it does not track
 * `sandbox.currentUser`.
 *
 * Intended for Studio's "edit anything as admin" surfaces (F2) and the
 * serve worker's `{ mode: 'admin' }` auth lens. For rules-applied
 * impersonation ("act as this user"), use `getFirestore(sandbox.withAuth({
 * uid }))` instead.
 *
 * @example
 * ```ts
 * import { initializeSandbox } from 'pyric/sandbox';
 * import { getAdminFirestore, doc, setDoc } from 'pyric/firestore';
 * const sandbox = initializeSandbox();
 * const adminDb = getAdminFirestore(sandbox);
 * await setDoc(doc(adminDb, 'locked/x'), { a: 1 }); // bypasses rules
 * ```
 */
export function getAdminFirestore(sandbox: Sandbox): Firestore;
export function getAdminFirestore(ctx: SandboxContext): Firestore;
export function getAdminFirestore(app: FirebaseApp): Firestore;
export function getAdminFirestore(target: Sandbox | SandboxContext | FirebaseApp): Firestore {
  const appRuntime = resolveClientApp(target);
  if (appRuntime) {
    appRuntime.assertAlive();
    const sandbox = appRuntime.sandbox;
    return getAdminFirestore(bindOperationContext(sandbox.withAuth(null), {
      source: { kind: 'app' },
      authLens: { mode: 'admin' },
    }));
  }
  const context = isSandboxContext(target)
    ? target
    : (target as Sandbox).withAuth(null);
  const sandbox = context.sandbox;
  const chainable = getChainableAdminFirestore(context);
  const t: SandboxTarget = { kind: 'sandbox', db: chainable, sandbox };
  return { [TARGET_SYMBOL]: t };
}

/**
 * Brand-based test for the SandboxContext overload. Uses
 * `instanceof SandboxContextImpl` for robustness — structural
 * dispatch would silently break if `SandboxContext`'s shape ever
 * changed, or if a future `FirebaseApp` grew a `withAuth` method.
 *
 * Internal — consumers always call `getFirestore` and let the
 * dispatch figure it out.
 */
function isSandboxContext(target: SandboxContext | Sandbox | FirebaseApp): target is SandboxContext {
  return target instanceof SandboxContextImpl;
}

/**
 * Structural test for the `Sandbox` overload. The class is internal
 * to `pyric/sandbox` (not exported), so we recognize it by the
 * presence of `currentUser` + `onCurrentUserChanged` + `withAuth` +
 * `admin` — the four members that distinguish `Sandbox` from
 * `SandboxContext` (which has `withAuth` only) and `FirebaseApp`
 * (which has none). Tightening to a brand symbol would require an
 * `pyric/sandbox` change; structural recognition is safe here
 * because every member of this set has been on `Sandbox` since v0
 * and `FirebaseApp` would have to grow all four to collide.
 */
function isSandbox(target: SandboxContext | Sandbox | FirebaseApp): target is Sandbox {
  if (target === null || typeof target !== 'object') return false;
  const o = target as unknown as Record<string, unknown>;
  return (
    typeof o.withAuth === 'function'
    && typeof o.onCurrentUserChanged === 'function'
    && 'currentUser' in o
    && 'admin' in o
  );
}

/**
 * Build the per-call ctx-resolver for a `sandbox-live` target. Each
 * call reads `sandbox.currentUser` (the source of truth that
 * `pyric/auth` writes through to), constructs a fresh
 * `SandboxContext`, and returns the chainable Firestore handle bound
 * to it. Constructing per-call is cheap — `SandboxContext` is a tiny
 * object — and `pyric-admin`'s `getFirestore(ctx)` caches by ctx
 * identity via WeakMap, so the chainable is collected once the ctx
 * is.
 *
 * `withAuth(null)` is the anonymous path; rules evaluate with
 * `request.auth == null`, matching production Firebase Auth's
 * "signed out" state.
 */
function makeGetDb(
  sandbox: Sandbox,
  currentUser: () => AuthState = () => sandbox.currentUser,
): () => SandboxFirestore {
  return () => {
    const ctx = bindOperationContext(sandbox.withAuth(currentUser()), {
      source: { kind: 'app' },
      authLens: { mode: 'app-session' },
    });
    return getChainableFirestore(ctx);
  };
}

// ─── Emulator-connect compatibility ──────────────────────────────────────

/**
 * No-op in the sandbox mirror because the sandbox already runs locally.
 *
 * The option shape remains source-compatible with Firebase so canonical
 * initialization code can call it unconditionally.
 */
export function connectFirestoreEmulator(
  db: Firestore,
  host: string,
  port: number,
  options?: {
    mockUserToken?: string | {
      sub?: string;
      user_id?: string;
      firebase?: { sign_in_provider?: string; identities?: Record<string, string[]> };
      [claim: string]: unknown;
    };
  },
): void {
  targetOf(db);
  void host;
  void port;
  void options;
}
