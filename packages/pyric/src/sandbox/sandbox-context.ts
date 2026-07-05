/**
 * `SandboxContext` — identity-bearing handle on a {@link Sandbox}.
 *
 * Cheap, immutable `(sandbox, auth)` pair. Service factories
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

import type { AuthState, Sandbox, SandboxContext } from './types.js';
import { SandboxError } from './types.js';

export class SandboxContextImpl implements SandboxContext {
  constructor(
    public readonly sandbox: Sandbox,
    public readonly auth: AuthState,
  ) {}

  withAuth(auth: AuthState): SandboxContext {
    validateAuthState(auth);
    return new SandboxContextImpl(this.sandbox, auth);
  }
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
