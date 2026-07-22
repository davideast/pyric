/**
 * `pyric/database` sandbox-only modular SDK mirror.
 *
 * Mirrors `firebase/database`'s tree-shakable free-function shape:
 * `getDatabase`, `ref`, `child`, `get`, `set`, `update`, `remove`,
 * `push`, `onValue`, `serverTimestamp`, `connectDatabaseEmulator`.
 *
 * Two sandbox identity modes are picked by what's passed to `getDatabase`:
 *
 *   - **Sandbox target** — wraps `RtdbBackend` (in-memory JSON tree
 *     plus the existing RTDB rule simulator). Identity is the
 *     `SandboxContext`'s frozen `auth`.
 *   - **Sandbox-live target** — same backend, but identity is read
 *     per-op from `sandbox.currentUser` so a `pyric/auth`-driven
 *     sign-in flips the next op's `request.auth` without re-binding.
 *
 * Routing machinery mirrors `pyric/firestore`:
 *   - {@link TARGET_SYMBOL} brand on every {@link Database} handle.
 *   - {@link refToTarget} WeakMap from refs to their owning target so
 *     chained calls (`child(ref, 'sub')`, `get(ref)`) recover routing.
 *
 * **Critical contract — error shape (locked by oracle observation
 * `packages/conformance/observations/rtdb/rtdb-rules-denied-error-code.json`):**
 *
 *   - Throws a **plain `Error`** (NOT a `FirebaseError`).
 *   - `.code === 'PERMISSION_DENIED'` (uppercase snake-case — distinct
 *     from Firestore's `'permission-denied'`).
 *   - `.message === 'PERMISSION_DENIED: Permission denied'`.
 *
 * The sandbox backend matches this shape exactly. Tests assert against
 * `.constructor.name === 'Error'` to catch any future "improvement" to
 * a custom subclass.
 */

import type { AuthState, Sandbox } from 'pyric/sandbox';
import type { RtdbBackend } from './sandbox/backend.js';
import type { RtdbConnectionLifecycle } from './connection-lifecycle.js';
import type { Unsubscribe } from './database-types.js';

// ─── Brand + routing ─────────────────────────────────────────────────

/** Hidden brand on every {@link Database} handle. */
export const TARGET_SYMBOL: unique symbol = Symbol('pyric/database/target');

export type SandboxTarget = {
  kind: 'sandbox';
  backend: RtdbBackend;
  auth: AuthState;
  admin?: boolean;
  connection: RtdbConnectionLifecycle;
};
export type SandboxLiveTarget = {
  kind: 'sandbox-live';
  backend: RtdbBackend;
  sandbox: Sandbox;
  currentUser?: () => AuthState;
  onCurrentUserChanged?: (callback: (user: AuthState) => void) => Unsubscribe;
  own?: (cleanup: () => void | Promise<void>) => () => void;
  assertUsable?: () => void;
  admin?: boolean;
  connection: RtdbConnectionLifecycle;
};
export type Target = SandboxTarget | SandboxLiveTarget;

/** Resolve the active identity for a sandbox-flavored target. */
export function authFor(t: SandboxTarget | SandboxLiveTarget): AuthState {
  if (t.admin) return null;
  return t.kind === 'sandbox' ? t.auth : (t.currentUser?.() ?? t.sandbox.currentUser);
}

const refToTarget = new WeakMap<object, Target>();

export function tag<T extends object>(obj: T, target: Target): T {
  refToTarget.set(obj, target);
  return obj;
}

export function targetOf(refOrDb: object): Target {
  let target: Target | undefined;
  if (TARGET_SYMBOL in refOrDb) {
    target = (refOrDb as { [TARGET_SYMBOL]: Target })[TARGET_SYMBOL];
  } else {
    target = refToTarget.get(refOrDb);
  }
  if (!target) {
    throw new TypeError(
      'pyric/database: unrecognized reference — was it produced by a factory in this package?',
    );
  }
  if (target.kind === 'sandbox-live') target.assertUsable?.();
  return target;
}
