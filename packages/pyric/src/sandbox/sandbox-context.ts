/**
 * `SandboxContext` — identity-bearing handle on a {@link Sandbox}.
 *
 * Cheap, immutable `(sandbox, auth, operationContext)` handle. Service factories
 * (`getFirestore`, future `getDatabase`, etc.) accept a
 * `SandboxContext` and route operations through the captured auth.
 *
 * Why a class (not just an interface):
 *   - `instanceof SandboxContextImpl` enables clean routing in
 *     service factories.
 *   - Method-based chaining (`ctx.withAuth(...)`) reads more
 *     naturally than a free function.
 *   - Class identity supports future debugging hooks
 *     (`Symbol.toStringTag`) without API breaks.
 *
 * Construct via `Sandbox.withAuth(...)` or chained via
 * `SandboxContext.withAuth(...)`. Consumers don't `new` this
 * directly — `Sandbox.withAuth` is the public entry. The class is
 * exported anyway so service-factory authors can name the type
 * (and so `instanceof` routing works for cross-package refs).
 */

import type { AuthState } from './types/auth-state.js';
import type { SandboxContext } from './types/context.js';
import type { AuthLens, OperationContext } from './types/events.js';
import { SandboxError } from './types/errors.js';
import type { Sandbox } from './types/service.js';
import { immutableOperationContext } from './operation-record.js';

function authLensFor(auth: AuthState): AuthLens {
  if (auth === null) return { mode: 'anon' };
  return auth.token === undefined
    ? { mode: 'as', uid: auth.uid }
    : { mode: 'as', uid: auth.uid, token: auth.token };
}

export class SandboxContextImpl implements SandboxContext {
  constructor(
    public readonly sandbox: Sandbox,
    public readonly auth: AuthState,
    operationContext?: OperationContext,
  ) {
    this.operationContext = immutableOperationContext(operationContext ?? {
      source: { kind: 'unattributed' },
      authLens: authLensFor(auth),
    });
  }

  public readonly operationContext: OperationContext;

  withAuth(auth: AuthState): SandboxContext {
    validateAuthState(auth);
    return new SandboxContextImpl(this.sandbox, auth, {
      source: this.operationContext.source,
      authLens: authLensFor(auth),
      ...(this.operationContext.planId === undefined
        ? {}
        : { planId: this.operationContext.planId }),
    });
  }
}

/** Bind source, lens, and optional plan identity to a sandbox handle. Service
 * adapters use this once when constructing a handle; individual operations
 * cannot accidentally omit or contradict it. */
export function bindOperationContext(
  ctx: SandboxContext,
  operationContext: OperationContext,
): SandboxContext {
  return new SandboxContextImpl(ctx.sandbox, ctx.auth, operationContext);
}

/**
 * Reject `undefined` and other clearly-malformed inputs at the
 * `withAuth` call site. `null` is valid (anonymous);
 * `{ uid: 'someUid' }` is valid; everything else throws so the
 * mistake surfaces at the boundary instead of leaking into rule
 * eval as a confusing denial.
 *
 * Shared between `Sandbox.withAuth` and `SandboxContext.withAuth`
 * so both entries enforce the same validation.
 */
export function validateAuthState(auth: unknown): asserts auth is AuthState {
  if (auth === null) return;
  if (auth === undefined) {
    throw new SandboxError({
      code: 'invalid-argument',
      message: 'withAuth() requires an explicit AuthState argument.',
      remediation: [
        'For anonymous (unauthenticated) access: withAuth(null)',
        'For authenticated access: withAuth({ uid: "someUid" })',
        'For custom claims: withAuth({ uid: "someUid", token: { role: "admin" } })',
      ].join('\n'),
    });
  }
  if (typeof auth !== 'object') {
    throw new SandboxError(
      'invalid-argument',
      'withAuth() expected null or an object with a `uid` field.',
    );
  }
  const obj = auth as Record<string, unknown>;
  if (typeof obj.uid !== 'string' || obj.uid.length === 0) {
    throw new SandboxError(
      'invalid-argument',
      'withAuth() requires `uid` to be a non-empty string.',
    );
  }
  if ('token' in obj && obj.token !== undefined) {
    if (obj.token === null || typeof obj.token !== 'object' || Array.isArray(obj.token)) {
      throw new SandboxError(
        'invalid-argument',
        'withAuth() requires `token` (when present) to be a plain object.',
      );
    }
  }
}
