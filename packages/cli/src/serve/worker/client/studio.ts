/**
 * Pyric Studio cross-service surfaces over the worker port — the unified event
 * stream (`subscribeEvents`/`eventHistory`) and the sandbox snapshot export
 * used by the rules re-run flow.
 */

import type { InboundMessage } from '../protocol.js';
import type { SandboxEvent, SandboxSnapshot } from 'pyric/sandbox';
import { nextId, nextSubId, rpc, _eventSubs } from './core.js';
import type { ClientDb, Unsubscribe } from './handles.js';

// ════════════════════════════════════════════════════════════════════════
//  EVENT STREAM (Pyric Studio keystone — onEvent/history over the port)
// ════════════════════════════════════════════════════════════════════════
//
// Surfaces the worker sandbox's unified cross-service event stream to the page.
// `subscribeEvents(db, cb)` registers a stream sub: the worker first delivers
// `sandbox.history()` as one batch, then streams each live `SandboxEvent` as a
// single-element batch. `eventHistory(db)` is a one-shot history fetch (a fresh
// short-lived sub) for consumers that want a snapshot without staying live.
//
// These mirror `sandbox.onEvent(cb)` / `sandbox.history()` so a consumer can
// adapt them into the same `{ onEvent, history }`-shaped source the in-process
// sandbox exposes (e.g. Studio's `feedFromSandboxLike`).

/**
 * Subscribe to the worker sandbox's unified event stream. The callback fires
 * with each delivered BATCH of events — the FIRST call carries the initial
 * `history()` snapshot (possibly empty), each subsequent call carries one live
 * event. Returns an unsubscribe that deregisters on the worker.
 *
 * This is the live counterpart to `sandbox.onEvent` + an initial `history()`
 * fold, collapsed into one subscription so a late subscriber never misses the
 * backlog.
 */
export function subscribeEvents(
  db: ClientDb,
  callback: (events: readonly SandboxEvent[]) => void,
): Unsubscribe {
  const subId = nextSubId();
  const port = db.port;
  _eventSubs.set(subId, callback);
  port.postMessage({ t: 'sub', subId, target: 'events' } satisfies InboundMessage);
  return () => {
    _eventSubs.delete(subId);
    port.postMessage({ t: 'unsub', subId } satisfies InboundMessage);
  };
}

/**
 * Fetch the worker sandbox's event history as a one-shot snapshot (every event
 * so far). Opens a transient stream sub, resolves with the initial history
 * batch, and tears the sub down immediately — so it never holds a live
 * subscription. Useful for a late, snapshot-only consumer.
 */
export function eventHistory(db: ClientDb): Promise<readonly SandboxEvent[]> {
  return new Promise((resolve) => {
    const unsub = subscribeEvents(db, (events) => {
      // The first delivery is the history snapshot; resolve + unsubscribe.
      unsub();
      resolve(events);
    });
  });
}

/**
 * Export the current sandbox snapshot (Pyric Studio rules re-run). Studio forks
 * it locally to test a denied op against edited rules or re-issue it as the
 * attempting user, on a throwaway branch (no live mutation).
 */
export async function getSnapshot(db: ClientDb): Promise<SandboxSnapshot> {
  return (await rpc(db.port, { t: 'op', id: nextId(), method: 'getSnapshot' })) as SandboxSnapshot;
}
