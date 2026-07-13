/**
 * SharedWorker host — Pyric Studio control ops.
 *
 * The runtime confirm-policy dial (`setPolicy`/`getPolicy`, F3) and the
 * sandbox-snapshot export Studio forks for rules re-run (`getSnapshot`). Small
 * surface, kept as its own family to mirror the client's `studio` module.
 *
 * Routed here by the host dispatcher. Never imports the dispatcher.
 */

import type { OpMessage } from '../protocol.js';
import { type HostCtx, type PortLike, ok, fail } from '../host-context.js';

/** The Studio control op methods routed to {@link handleStudioOp}. */
const STUDIO_METHODS = new Set<string>([
  'setPolicy',
  'getPolicy',
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
    case 'setPolicy': {
      // Store the dial's PolicyRequest as the worker-side runtime governance
      // (Pyric Studio F3). This is the source of truth Studio reflects + a
      // future in-worker agent runtime consults. It does NOT push into a
      // running bridge process — see the limitation note on `ctx.policy` /
      // `PolicyRequest`. Additive + idempotent: last write wins.
      ctx.policy = msg.policy;
      ok(port, msg.id, null);
      break;
    }

    case 'getPolicy': {
      // Read back the active runtime policy (null until the dial set one), so
      // Studio can reflect persisted state across reconnects within a worker
      // lifetime and a freshly-connecting port can hydrate the dial.
      ok(port, msg.id, ctx.policy ?? null);
      break;
    }

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
