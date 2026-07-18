/**
 * EventBus — subscriber registries and dispatch for the Firestore sandbox
 * engine's seven observational event channels (ADR-0009, PR B1).
 *
 * The bus owns ONLY subscription and dispatch. Payload building stays at the
 * emit call sites in LocalEnvironment: events allocate lazily (callers check
 * {@link EventChannel.hasSubscribers} first — eval rate can reach ~4500/sec
 * in listener-storm scenarios), and several payloads read the engine's
 * trigger context, which remains engine-owned until PR B2's TriggerScope.
 *
 * Dispatch semantics are part of each channel's interface:
 *   - Subscribers are invoked in insertion order (native `Set` iteration,
 *     iterated live — a subscriber removed mid-dispatch before its turn is
 *     skipped; one added mid-dispatch IS visited in the same pass).
 *   - Synchronous subscriber throws are swallowed: an observational consumer
 *     must not change engine semantics.
 *   - Channels constructed with `swallowAsyncRejections` also attach a noop
 *     `.catch` to thenable return values, so an `async (e) => { throw }`
 *     subscriber can't raise an unhandledRejection that kills the process
 *     (Node >= 15 default config) and every other observer with it.
 */
import type { FirestoreSimError } from './errors.js';
import type { SnapshotTarget } from './snapshot-listeners.js';
import type {
  RequestEvent,
  WriteSandboxEvent,
  SnapshotDeliveryEvent,
  SnapshotSuppressedEvent,
  ListenerLifecycleEvent,
} from '../../sandbox/types/events.js';

/** One observational channel: a subscriber Set plus its dispatch loop. */
export class EventChannel<Args extends unknown[]> {
  private readonly subscribers = new Set<(...args: Args) => void>();

  constructor(private readonly swallowAsyncRejections = false) {}

  /** True when at least one subscriber is attached. Emit call sites check
   *  this before building a payload so the hot path stays allocation-free. */
  get hasSubscribers(): boolean {
    return this.subscribers.size > 0;
  }

  /** Attach a subscriber. Returns an idempotent unsubscribe function. */
  subscribe(cb: (...args: Args) => void): () => void {
    this.subscribers.add(cb);
    return () => { this.subscribers.delete(cb); };
  }

  /** Dispatch to every subscriber under the isolation rules documented on
   *  the module: insertion order, live Set iteration, throws swallowed. */
  emit(...args: Args): void {
    for (const cb of this.subscribers) {
      try {
        const result = cb(...args) as unknown;
        if (
          this.swallowAsyncRejections &&
          result && typeof (result as { then?: unknown }).then === 'function'
        ) {
          (result as Promise<unknown>).catch(() => { /* observational — never propagate */ });
        }
      } catch { /* observational — never propagate */ }
    }
  }

  /** Drop every subscriber (engine dispose). */
  clear(): void {
    this.subscribers.clear();
  }
}

/** The engine's seven channels, grouped as one injected collaborator. */
export class FirestoreEventBus {
  /** Every constructed `permission-denied`, even when user code catches the
   *  resulting throw — hosts (playground, tests) surface denials with full
   *  eval context that `e.code` alone hides. */
  readonly denial = new EventChannel<[err: FirestoreSimError]>();

  /** Every evaluated op (issue #307), public-shape `RequestEvent`.
   *  Async-subscriber rejections are swallowed. */
  readonly request = new EventChannel<[event: RequestEvent]>(true);

  /** Every COMMITTED write — denied / rolled-back writes surface as a
   *  request-deny RequestEvent instead. Bridged to `Sandbox.onEvent` by
   *  SandboxImpl. Async-subscriber rejections are swallowed. */
  readonly write = new EventChannel<[event: WriteSandboxEvent]>(true);

  /** Every snapshot DELIVERED to a user `onSnapshot` callback — fires after
   *  the suppress-check, so counts track real callback invocations. */
  readonly delivery = new EventChannel<[event: SnapshotDeliveryEvent]>();

  /** Listener re-evals suppressed before reaching the user callback —
   *  "why didn't my listener fire" debugging. */
  readonly suppressed = new EventChannel<[event: SnapshotSuppressedEvent]>();

  /** Listener attach / detach lifecycle. Errored routes through
   *  {@link snapshotError} so this channel carries only attach + detach. */
  readonly lifecycle = new EventChannel<[event: ListenerLifecycleEvent]>();

  /** Snapshot-listener stream errors (Slice 7): fans out alongside the
   *  listener's own `errorCallback` so a host UI can attribute the error
   *  to a specific watch. */
  readonly snapshotError = new EventChannel<
    [err: FirestoreSimError, target: SnapshotTarget, listenerId: string]
  >();

  /** Drop every subscriber on every channel (engine dispose). */
  clear(): void {
    this.denial.clear();
    this.request.clear();
    this.write.clear();
    this.delivery.clear();
    this.suppressed.clear();
    this.lifecycle.clear();
    this.snapshotError.clear();
  }
}
