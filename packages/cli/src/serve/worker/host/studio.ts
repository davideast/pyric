/**
 * SharedWorker host — Pyric Studio control ops.
 *
 * The sandbox-snapshot export Studio forks for rules re-run (`getSnapshot`).
 * Kept as its own family to mirror the client's `studio` module.
 *
 * Routed here by the host dispatcher. Never imports the dispatcher.
 */

import type { SandboxSnapshot } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import { sandbox as rtdbSandbox } from 'pyric/database';
import { Path as RulesPath } from 'pyric/rules/internal';
import { normalizeDatabaseRules } from './rules.js';

import type { OpMessage } from '../protocol.js';
import { type HostCtx, type PortLike, ok, fail, bestEffortFlush } from '../host-context.js';
import { restoreFirestoreSubscriptions } from './subscriptions.js';

/**
 * Encode a live sandbox Firestore value into a plain JSON-safe wire tree with
 * zero binary buffers (`Uint8Array`) or prototype-dependent class instances:
 *   - `RulesValue` / SDK instances with `.toJSON()` serialize to their marker
 *     objects (`{ __type: 'timestamp' | 'bytes' | 'latlng' | 'reference' | 'duration' }`,
 *     `{ __type__: '__vector__', value }`, etc.); `Path` also retains bindings.
 *   - Plain user maps containing `type`, `__type`, or `__type__` escape into
 *     `{ type: 'pyric/map/1.0', fields }` so client rehydration never mistakes
 *     user data for a wrapper marker.
 *   - Non-JSON IEEE-754 numbers (`NaN`, `±Infinity`, `-0`) use `{ __type: 'number', value }`
 *     so they survive both `MessagePort` and JSON relay transports losslessly.
 */
function encodeSnapshotValue(value: unknown): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { __type: 'number', value: 'NaN' };
    if (value === Infinity) return { __type: 'number', value: 'Infinity' };
    if (value === -Infinity) return { __type: 'number', value: '-Infinity' };
    if (Object.is(value, -0)) return { __type: 'number', value: '-0' };
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(encodeSnapshotValue);
  }
  if (typeof value === 'object') {
    if (value instanceof RulesPath) {
      const hasBindings = Object.keys(value.bindings).length > 0;
      return hasBindings
        ? { __type: 'path', segments: [...value.segments], bindings: { ...value.bindings } }
        : { __type: 'path', segments: [...value.segments] };
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
      return (value as { toJSON(): unknown }).toJSON();
    }
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      fields[k] = encodeSnapshotValue(v);
    }
    const hasMarkerField = Object.hasOwn(fields, 'type')
      || Object.hasOwn(fields, '__type')
      || Object.hasOwn(fields, '__type__');
    return hasMarkerField ? { type: 'pyric/map/1.0', fields } : fields;
  }
  return value;
}

function encodeSandboxSnapshot(raw: SandboxSnapshot): SandboxSnapshot {
  const firestore: Record<string, Record<string, unknown>> = {};
  for (const [docPath, docData] of Object.entries(raw.firestore)) {
    firestore[docPath] = encodeSnapshotValue(docData) as Record<string, unknown>;
  }
  return { firestore, services: raw.services };
}

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
      ok(port, msg.id, encodeSandboxSnapshot(ctx.sandbox.snapshot()));
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
        // Reset clears Firestore and RTDB rules. Restore the active project
        // policy before serving reads or reattaching Firestore listeners.
        const firestoreRules = ctx.activeRules?.firestore;
        const hasActiveRules = firestoreRules?.status === 'active';
        const source = hasActiveRules ? firestoreRules.source : firestoreRules?.lastKnownGood;
        const hasRulesSource = typeof source === 'string';
        if (hasRulesSource) setRules(ctx.sandbox, source);
        // Each RTDB instance gets its own rules back.
        for (const [, instance] of ctx.rtdbInstances?.entries() ?? []) {
          const databaseRules = instance.rules;
          const hasActiveDatabaseRules = databaseRules?.status === 'active';
          const databaseSource = hasActiveDatabaseRules ? databaseRules.source : databaseRules?.lastKnownGood;
          const hasDatabaseSource = databaseSource !== undefined;
          if (hasDatabaseSource) rtdbSandbox.setRules(instance.live, normalizeDatabaseRules(databaseSource));
        }
        restoreFirestoreSubscriptions(ctx);
        // The server capture (`.pyric/last-session.json`) persists the event
        // history a rebooting worker re-primes into Traffic. Flush it NOW —
        // reset just emptied `sandbox.history()`, and waiting out the
        // capture debounce leaves a window where a worker death resurrects
        // the wiped session's events on the next boot.
        await ctx.captureFlush?.();
        // The hosted policy waits for earlier saves and persists the cleared state.
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, { errors });
      } catch (e) {
        const isError = e instanceof Error;
        if (isError) fail(port, msg.id, e);
        else fail(port, msg.id, new Error(String(e)));
      }
      break;
    }

    default: {
      fail(port, msg.id, new Error(`Unknown method: ${String(msg.method)}`));
    }
  }
}
