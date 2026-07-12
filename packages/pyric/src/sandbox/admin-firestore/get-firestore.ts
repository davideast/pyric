/**
 * `getFirestore(ctx)` — the rules-enforced `SandboxFirestore` resolver.
 * Dispatches to the local engine handle or the channel-backed remote arm
 * depending on the context's sandbox brand.
 */

import { isRemoteSandbox, type AuthLens, type AuthState, type SandboxContext } from 'pyric/sandbox';
import { wrapWithErrorTranslation } from './error-translation.js';
import { buildFirestoreHandle } from './local-handle.js';
import { createRemoteFirestore } from './remote/remote-firestore.js';
import type { SandboxFirestore } from './types.js';

/**
 * Idempotency cache. Each `SandboxContext` gets its own handle because
 * each context carries its own auth identity. Cached by reference,
 * garbage-collected with the context.
 */
const handleCache = new WeakMap<SandboxContext, SandboxFirestore>();

/**
 * Resolve the Firestore service handle for a context. Idempotent —
 * subsequent calls with the same context return the same wrapper.
 *
 * Requires a `SandboxContext`, never a bare `Sandbox`. Anonymous is
 * `sandbox.withAuth(null)`, written explicitly — every call site
 * states identity.
 *
 * @example
 * ```ts
 * import { initializeSandbox } from 'pyric/sandbox';
 * import { getFirestore } from 'pyric-admin/firestore';
 *
 * const sandbox = initializeSandbox();
 * const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
 * db.setRules(MY_RULES);
 * db.seed({ documents: { 'tickets/T-1': { ... } } });
 *
 * // Different identity? Different context, same data.
 * const dbAsBob = getFirestore(sandbox.withAuth({ uid: 'bob' }));
 * ```
 */
export function getFirestore(ctx: SandboxContext): SandboxFirestore {
  const cached = handleCache.get(ctx);
  if (cached) return cached;
  // REMOTE ARM (remote sandbox, slice 2): a remote-branded sandbox has no
  // in-process engine — return the channel-backed parallel implementation
  // instead of building the local compat handle. Identity mapping: the
  // context's frozen auth pins the per-op lens — `withAuth(null)` means
  // `{ mode: 'anon' }` (an ABSENT lens would silently resolve to the
  // browser tab's port session), and a signed identity pins
  // `{ mode: 'as', uid, token? }` with the FULL claims token (the worker
  // resolves it via `sandbox.withAuth({ uid, token })`, so custom claims
  // evaluate in rules exactly as on the local arm).
  const fresh = isRemoteSandbox(ctx.sandbox)
    ? createRemoteFirestore(ctx.sandbox, lensForAuth(ctx.auth))
    : // Wrap the raw handle so every operation (and every object returned
      // from it: `DocumentReference`, `Query`, `WriteBatch`, `Transaction`)
      // re-throws compat errors as `SandboxError` with structured
      // `denialContext`. The wrapper also stashes `ctx` on every wrapped
      // value via CONTEXT_SYMBOL so `onSnapshot` can recover it.
      wrapWithErrorTranslation(buildFirestoreHandle(ctx), ctx);
  handleCache.set(ctx, fresh);
  return fresh;
}

/** Map a context's frozen `AuthState` to the worker-relay lens the remote
 *  arm pins on every op/sub. Never absent — see {@link getFirestore}. */
export function lensForAuth(auth: AuthState): AuthLens {
  if (auth === null || auth === undefined) return { mode: 'anon' };
  return auth.token === undefined
    ? { mode: 'as', uid: auth.uid }
    : { mode: 'as', uid: auth.uid, token: auth.token };
}
