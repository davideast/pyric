/**
 * `getAdminFirestore(target)` — the rules-bypassing `SandboxFirestore`
 * resolver (the Pyric Studio admin lens, Gap #2).
 */

import { isRemoteSandbox, type Sandbox, type SandboxContext } from 'pyric/sandbox';
import { wrapWithErrorTranslation } from './error-translation.js';
import { buildFirestoreHandle } from './local-handle.js';
import { createRemoteFirestore } from './remote/remote-firestore.js';
import type { SandboxFirestore } from './types.js';

/**
 * Idempotency cache for admin (rules-bypassing) handles. Keyed by ctx,
 * SEPARATE from `getFirestore`'s handle cache so the same
 * `SandboxContext` can vend both a rules-enforced handle (`getFirestore`)
 * and a rules-bypassing one (`getAdminFirestore`) without one clobbering
 * the other.
 */
const adminHandleCache = new WeakMap<SandboxContext, SandboxFirestore>();

/**
 * Resolve a **rules-bypassing** Firestore handle for a context — the
 * Pyric Studio admin lens (Gap #2). Same chainable `SandboxFirestore`
 * surface as `getFirestore`, but every operation it issues (reads,
 * writes, queries, batches, transactions) SKIPS security-rule evaluation
 * and is treated as ALLOW. This is the modular/chainable-shaped sibling of
 * the path-string `sandbox.admin.*` bypass — it reuses the exact same
 * `LocalEnvironment` bypass execution path (`bypassRules` on the op),
 * rather than reimplementing it.
 *
 * Storage preconditions still apply (a `create` on an existing doc still
 * fails `already-exists`, matching real Firestore admin), and the same
 * `request`/`write` events fire + listeners wake, so the change shows up
 * live and on the traffic log (stamped as an admin-bypass read/write).
 *
 * Use for "edit anything as admin" surfaces (Studio F2). For rules-applied
 * impersonation ("act as this user"), use `getFirestore(sandbox.withAuth({
 * uid }))` instead — that path is unchanged.
 *
 * @example
 * ```ts
 * import { initializeSandbox } from 'pyric/sandbox';
 * import { getFirestore, getAdminFirestore } from 'pyric-admin/firestore';
 *
 * const sandbox = initializeSandbox();
 * getFirestore(sandbox.withAuth(null)).setRules('...deny everything...');
 *
 * // Denied under rules:
 * await getFirestore(sandbox.withAuth({ uid: 'alice' }))
 *   .doc('locked/x').set({ a: 1 }); // throws permission-denied
 *
 * // Bypasses rules:
 * await getAdminFirestore(sandbox).doc('locked/x').set({ a: 1 }); // ok
 * ```
 */
export function getAdminFirestore(ctx: SandboxContext): SandboxFirestore;
export function getAdminFirestore(sandbox: Sandbox): SandboxFirestore;
export function getAdminFirestore(target: SandboxContext | Sandbox): SandboxFirestore {
  // Admin reads/writes are identity-agnostic (rules are off), so a bare
  // `Sandbox` is accepted as well as a `SandboxContext`. A bare sandbox is
  // normalised to an anonymous ctx — the captured auth is irrelevant since
  // no rule reads `request.auth` on the bypass path.
  const ctx: SandboxContext = isSandboxContext(target)
    ? target
    : target.withAuth(null);
  const cached = adminHandleCache.get(ctx);
  if (cached) return cached;
  // REMOTE ARM: rules bypass rides the worker's `{ mode: 'admin' }` lens
  // (the same lens Studio's admin surface uses) — identity-agnostic, so
  // the normalised ctx's auth is irrelevant, exactly like the local path.
  const fresh = isRemoteSandbox(ctx.sandbox)
    ? createRemoteFirestore(ctx.sandbox, { mode: 'admin' })
    : wrapWithErrorTranslation(buildFirestoreHandle(ctx, true), ctx, true);
  adminHandleCache.set(ctx, fresh);
  return fresh;
}

/**
 * Brand test for the `SandboxContext` overload of {@link getAdminFirestore}.
 * A `SandboxContext` carries `withAuth` + a `sandbox` back-reference; a bare
 * `Sandbox` carries `withAuth` too but also `admin`/`currentUser`. We test
 * for the `sandbox` property which only the context has.
 */
function isSandboxContext(target: SandboxContext | Sandbox): target is SandboxContext {
  return (
    target !== null &&
    typeof target === 'object' &&
    'sandbox' in target &&
    typeof (target as { withAuth?: unknown }).withAuth === 'function'
  );
}
