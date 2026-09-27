/**
 * Pyric Studio cross-service surfaces over the worker port — the unified event
 * stream (`subscribeEvents`/`eventHistory`) and the sandbox snapshot export
 * used by the rules re-run flow.
 */

import type { InboundMessage } from '../protocol.js';
import type { SandboxEvent, SandboxSnapshot } from 'pyric/sandbox';
import { EventHistory, OBSERVATION_HISTORY_LIMITS } from 'pyric/sandbox/internal';
import { closeSubscription, nextId, nextSubId, openEventSubscription, rpc } from './core.js';
import type { ClientDb, ClientPort, Unsubscribe } from './handles.js';

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

interface EventSubscriber {
  callback: (events: readonly SandboxEvent[]) => void;
  onError?: (error: Error & { code: string }) => void;
  /** Receives live batches once it has received the history. */
  primed: boolean;
}

/**
 * One event-stream subscription per port, shared by every local subscriber.
 * The host replays its whole history to each event subscription it receives,
 * so a subscription per consumer multiplied that replay on one connection.
 * The page keeps its own bounded copy of the stream and replays it to
 * subscribers that arrive after the host's history.
 */
interface SharedEventStream {
  subId: string;
  subscribers: Set<EventSubscriber>;
  history: EventHistory;
  /** True once the host's first batch (its history) has arrived. */
  received: boolean;
}

const sharedStreams = new WeakMap<ClientPort, SharedEventStream>();

/** Deliver to one subscriber; a throwing consumer does not stop the others. */
function deliver(subscriber: EventSubscriber, events: readonly SandboxEvent[]): void {
  try {
    subscriber.callback(events);
  } catch (error) {
    console.error('pyric: Uncaught Error in event subscriber:', error);
  }
}

function openSharedStream(port: ClientPort, first: EventSubscriber): void {
  const stream: SharedEventStream = {
    subId: nextSubId(),
    subscribers: new Set([first]),
    history: new EventHistory(OBSERVATION_HISTORY_LIMITS),
    received: false,
  };
  sharedStreams.set(port, stream);
  const next = (events: readonly SandboxEvent[]): void => {
    for (const event of events) stream.history.append(event);
    const isHistory = !stream.received;
    stream.received = true;
    for (const subscriber of [...stream.subscribers]) {
      if (isHistory) subscriber.primed = true;
      if (subscriber.primed) deliver(subscriber, events);
    }
  };
  const fail = (error: Error & { code: string }): void => {
    if (sharedStreams.get(port) === stream) sharedStreams.delete(port);
    for (const subscriber of [...stream.subscribers]) subscriber.onError?.(error);
    stream.subscribers.clear();
  };
  const message = { t: 'sub', subId: stream.subId, target: 'events' } satisfies InboundMessage;
  // A closed port reports to the first subscriber through `fail` and leaves no stream behind.
  openEventSubscription(port, stream.subId, next, message, fail);
}

/**
 * Subscribe to the worker sandbox's unified event stream. The callback fires
 * with each delivered BATCH of events — the FIRST call carries the initial
 * `history()` snapshot (possibly empty), each subsequent call carries one live
 * event. Returns an unsubscribe; the port's stream closes on the worker when
 * its last subscriber leaves.
 *
 * This is the live counterpart to `sandbox.onEvent` + an initial `history()`
 * fold, collapsed into one subscription so a late subscriber never misses the
 * backlog. Every subscriber on a port shares one stream from the worker.
 */
export function subscribeEvents(
  db: ClientDb,
  callback: (events: readonly SandboxEvent[]) => void,
  onError?: (error: Error & { code: string }) => void,
): Unsubscribe {
  const port = db.port;
  const subscriber: EventSubscriber = { callback, onError, primed: false };
  const existing = sharedStreams.get(port);
  if (existing) {
    existing.subscribers.add(subscriber);
    if (existing.received) {
      // Replay after this call returns, as the worker's first batch would arrive.
      queueMicrotask(() => {
        if (!existing.subscribers.has(subscriber)) return;
        subscriber.primed = true;
        deliver(subscriber, existing.history.snapshot());
      });
    }
  } else {
    openSharedStream(port, subscriber);
  }
  return () => {
    const stream = sharedStreams.get(port);
    const isMember = stream !== undefined && stream.subscribers.delete(subscriber);
    if (!isMember || stream.subscribers.size > 0) return;
    sharedStreams.delete(port);
    closeSubscription(port, stream.subId);
  };
}

/**
 * Fetch the worker sandbox's event history as a one-shot snapshot (every event
 * so far). Opens a transient stream sub, resolves with the initial history
 * batch, and tears the sub down immediately — so it never holds a live
 * subscription. Useful for a late, snapshot-only consumer.
 */
export function eventHistory(db: ClientDb): Promise<readonly SandboxEvent[]> {
  return new Promise((resolve, reject) => {
    const unsub = subscribeEvents(db, (events) => {
      // The first delivery is the history snapshot; resolve + unsubscribe.
      unsub();
      resolve(events);
    }, reject);
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

/**
 * Sandbox-owned full reset (issue #359): `sandbox.resetAll()` on the worker.
 * Clears the Firestore env, the signed-in session, and EVERY registered
 * persistable service — auth users, the RTDB tree, storage objects. Resolves
 * once the worker acks (all services finished clearing). This is the served
 * counterpart of calling `sandbox.resetAll()` on an in-process sandbox.
 */
export async function resetAll(db: ClientDb): Promise<{ errors: string[] }> {
  const reply = await rpc(db.port, { t: 'op', id: nextId(), method: 'resetAll' });
  return (reply ?? { errors: [] }) as { errors: string[] };
}
