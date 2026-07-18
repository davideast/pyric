/**
 * SharedWorker host — Pyric Studio control ops.
 *
 * The sandbox-snapshot export Studio forks for rules re-run (`getSnapshot`).
 * Kept as its own family to mirror the client's `studio` module.
 *
 * Routed here by the host dispatcher. Never imports the dispatcher.
 */

import { setRules } from 'pyric/sandbox/firestore';

import type { OpMessage } from '../protocol.js';
import { type HostCtx, type PortLike, ok, fail } from '../host-context.js';

/** The Studio control op methods routed to {@link handleStudioOp}. */
const STUDIO_METHODS = new Set<string>([
  'getSnapshot',
  'resetAll',
]);

export function isStudioOp(method: OpMessage['method']): boolean {
  return STUDIO_METHODS.has(method);
}

export async function handleStudioOp(
  ctx: HostCtx,
  port: PortLike,
  msg: OpMessage,
): Promise<void> {
  switch (msg.method) {
    case 'getSnapshot': {
      // Export the current sandbox snapshot (Pyric Studio rules re-run): Studio
      // forks it locally to test edited rules / re-issue as the user on a branch.
      ok(port, msg.id, ctx.sandbox.snapshot());
      break;
    }

    case 'resetAll': {
      // Sandbox-owned full reset (issue #359): the ONE wipe-everything path.
      // `resetAll` iterates the worker sandbox's persistable-service registry,
      // so auth users, the RTDB tree, AND storage objects clear along with the
      // Firestore env — Studio can't forget a service the sandbox knows about.
      // Awaited (storage clears IndexedDB stores) before the ack. Op-level
      // failures reply as errors; per-service reset failures ride the reply
      // payload's `errors` so Studio can surface a half-clear instead of
      // reporting a clean reset.
      try {
        const { errors } = await ctx.sandbox.resetAll();
        // `resetAll` swapped the env, wiping env-owned FIRESTORE rules (RTDB /
        // storage rules live on their service objects and survive). Re-deploy
        // the active project rules so a DATA reset never de-governs writes.
        const firestoreRules = ctx.activeRules?.firestore;
        const source =
          firestoreRules?.status === 'active'
            ? firestoreRules.source
            : firestoreRules?.lastKnownGood;
        if (typeof source === 'string') setRules(ctx.sandbox, source);
        // The server capture (`.pyric/last-session.json`) persists the event
        // history a rebooting worker re-primes into Traffic. Flush it NOW —
        // reset just emptied `sandbox.history()`, and waiting out the
        // capture debounce leaves a window where a worker death resurrects
        // the wiped session's events on the next boot.
        ctx.captureFlush?.();
        ok(port, msg.id, { errors });
      } catch (e) {
        fail(port, msg.id, e instanceof Error ? e : new Error(String(e)));
      }
      break;
    }

    default: {
      fail(port, msg.id, new Error(`Unknown method: ${String((msg as { method: unknown }).method)}`));
    }
  }
}
