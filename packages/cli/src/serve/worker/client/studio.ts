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
  isPrimed: boolean;
}

/**
 * The one event-stream subscription a port holds on the worker, shared by every
 * local subscriber. The worker replays its whole history to each event
 * subscription it receives, so a port subscribes once. The page keeps a copy
 * of the stream, bounded like the worker's history, and replays it to a
 * subscriber that arrives after the worker's history batch.
 */
class SharedEventStream {
  readonly subId = nextSubId();
  readonly subscribers = new Set<EventSubscriber>();
  private readonly history = new EventHistory(OBSERVATION_HISTORY_LIMITS);
  /** The next batch is the worker's whole history: on the first subscription and after each restore. */
  private isAwaitingHistory = true;
  private hasReceivedHistory = false;

  constructor(private readonly port: ClientPort) {}

  open(first: EventSubscriber): void {
    this.subscribers.add(first);
    sharedStreams.set(this.port, this);
    const message = { t: 'sub', subId: this.subId, target: 'events' } satisfies InboundMessage;
    // A closed port reports to `first` through `fail` and leaves no stream behind.
    openEventSubscription(
      this.port,
      this.subId,
      (events) => this.receive(events),
      message,
      (error) => this.fail(error),
      () => { this.isAwaitingHistory = true; },
    );
  }

  join(subscriber: EventSubscriber): void {
    this.subscribers.add(subscriber);
    if (!this.hasReceivedHistory) return;
    // Replay after the caller returns, as the worker's history batch would arrive.
    queueMicrotask(() => {
      if (this.subscribers.has(subscriber)) prime(subscriber, this.history.snapshot());
    });
  }

  leave(subscriber: EventSubscriber): void {
    const wasMember = this.subscribers.delete(subscriber);
    const isLastSubscriber = wasMember && this.subscribers.size === 0;
    if (!isLastSubscriber) return;
    sharedStreams.delete(this.port);
    closeSubscription(this.port, this.subId);
  }

  private receive(events: readonly SandboxEvent[]): void {
    const isHistory = this.isAwaitingHistory;
    if (isHistory) this.history.clear();
    for (const event of events) this.record(event);
    this.isAwaitingHistory = false;
    const isFirstHistory = isHistory && !this.hasReceivedHistory;
    this.hasReceivedHistory = true;
    for (const subscriber of [...this.subscribers]) {
      const isStillSubscribed = this.subscribers.has(subscriber);
      if (!isStillSubscribed) continue;
      if (isFirstHistory) prime(subscriber, events);
      else if (subscriber.isPrimed) deliver(subscriber, events);
    }
  }

  /** Mirror the worker's history: a reset boundary clears it and is not retained. */
  private record(event: SandboxEvent): void {
    const resetsSession = event.kind === 'session_boundary' && event.phase === 'reset';
    if (resetsSession) this.history.clear();
    else this.history.append(event);
  }

  private fail(error: Error & { code: string }): void {
    if (sharedStreams.get(this.port) === this) sharedStreams.delete(this.port);
    const subscribers = [...this.subscribers];
    this.subscribers.clear();
    for (const subscriber of subscribers) {
      try {
        subscriber.onError?.(error);
      } catch (thrown) {
        console.error('pyric: Uncaught Error in event subscriber error handler:', thrown);
      }
    }
  }
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

/** A subscriber's first delivery is the history; live batches follow it. */
function prime(subscriber: EventSubscriber, history: readonly SandboxEvent[]): void {
  subscriber.isPrimed = true;
  deliver(subscriber, history);
}

/**
 * Subscribe to the worker sandbox's unified event stream. The callback fires
 * with each delivered BATCH of events: the FIRST call carries the history
 * (possibly empty), each later call carries one live event. Every subscriber on
 * a port shares one subscription on the worker; a subscriber that joins after
 * the worker's history batch receives the page's copy of it, bounded like the
 * worker's history. Returns an unsubscribe; the worker subscription closes when
 * the port's last subscriber leaves.
 *
 * This is the live counterpart to `sandbox.onEvent` + an initial `history()`
 * fold, collapsed into one subscription so a late subscriber never misses the
 * backlog.
 */
export function subscribeEvents(
  db: ClientDb,
  callback: (events: readonly SandboxEvent[]) => void,
  onError?: (error: Error & { code: string }) => void,
): Unsubscribe {
  const port = db.port;
  const subscriber: EventSubscriber = { callback, onError, isPrimed: false };
  const existing = sharedStreams.get(port);
  if (existing) existing.join(subscriber);
  else new SharedEventStream(port).open(subscriber);
  return () => {
    sharedStreams.get(port)?.leave(subscriber);
  };
}

/**
 * Fetch the worker sandbox's event history as a one-shot snapshot. Resolves
 * with the first batch a new subscriber receives, then unsubscribes, so it
 * holds no subscription of its own. When the port already has a live stream,
 * the history comes from the page's copy of it, bounded like the worker's.
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
