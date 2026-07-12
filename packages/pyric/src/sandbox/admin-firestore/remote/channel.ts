/**
 * Channel plumbing shared by every remote-arm constructor: the per-handle
 * immutable state (channel + pinned identity lens) and the one op
 * dispatcher every read/write/query/transaction call goes through.
 *
 * IDENTITY: every op and every subscription pins an EXPLICIT `actAs` lens.
 * An ABSENT lens resolves worker-side to the browser tab's PORT SESSION —
 * whoever happens to be signed in in the tab — which is never what a
 * server-side handle means. `getAdminFirestore` pins `{ mode: 'admin' }`
 * (rules bypass); `getFirestore(ctx)` pins `{ mode: 'as', uid, token? }`
 * for a signed identity or `{ mode: 'anon' }` for `withAuth(null)`.
 */

import type { AuthLens, RemoteSandbox } from 'pyric/sandbox';
import { toRemoteSandboxError } from './errors.js';

/** Per-handle immutable state: the relay channel + the pinned lens. */
export interface RemoteArm {
  readonly sandbox: RemoteSandbox;
  readonly lens: AuthLens;
}

/** Dispatch one worker op with the handle's lens pinned; wire errors
 *  re-shape into `SandboxError`. */
export async function armOp(arm: RemoteArm, op: Record<string, unknown>): Promise<unknown> {
  try {
    return await arm.sandbox.channel.op({
      ...(op as { method: string }),
      actAs: arm.lens,
    });
  } catch (e) {
    throw toRemoteSandboxError(e);
  }
}
