/**
 * The result the identity methods return.
 *
 * `impersonate`, the two `actAs` methods, `useAppSession`, and `whoami` all
 * report the same thing: the identity every later call runs under. They differ
 * in what they set it to, so the reporting lives here once and each record
 * names only the mode it selects.
 */
import type { IdentityInput } from './identity.js';
import type { OperationResult, SurfaceContext } from './types.js';

/** Report the held identity in the shape every identity method returns. */
function reported(held: { mode: string; uid?: string }): OperationResult {
  return {
    ok: true,
    summary: held.uid ? `Acting as ${held.uid}` : `Acting as ${held.mode}`,
    data: { identity: held },
  };
}

/** Set the identity every later call runs under, and report it. */
export function switchHeldIdentity(ctx: SurfaceContext, input: IdentityInput): OperationResult {
  return reported(ctx.identity.switchTo(input));
}

/** Report the identity later calls run under, without changing it. */
export function describeHeldIdentity(ctx: SurfaceContext): OperationResult {
  return reported(ctx.identity.describe());
}
