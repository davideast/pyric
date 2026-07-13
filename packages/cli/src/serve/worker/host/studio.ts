/**
 * SharedWorker host — Pyric Studio control ops.
 *
 * The sandbox-snapshot export Studio forks for rules re-run (`getSnapshot`).
 * Kept as its own family to mirror the client's `studio` module.
 *
 * Routed here by the host dispatcher. Never imports the dispatcher.
 */

import type { OpMessage } from '../protocol.js';
import { type HostCtx, type PortLike, ok, fail } from '../host-context.js';

/** The Studio control op methods routed to {@link handleStudioOp}. */
const STUDIO_METHODS = new Set<string>([
  'getSnapshot',
]);

export function isStudioOp(method: OpMessage['method']): boolean {
  return STUDIO_METHODS.has(method);
}

export function handleStudioOp(
  ctx: HostCtx,
  port: PortLike,
  msg: OpMessage,
): void {
  switch (msg.method) {
    case 'getSnapshot': {
      // Export the current sandbox snapshot (Pyric Studio rules re-run): Studio
      // forks it locally to test edited rules / re-issue as the user on a branch.
      ok(port, msg.id, ctx.sandbox.snapshot());
      break;
    }

    default: {
      fail(port, msg.id, new Error(`Unknown method: ${String((msg as { method: unknown }).method)}`));
    }
  }
}
