/**
 * ListenerDispatch — the snapshot-listener registry and delivery machinery
 * for the Firestore sandbox engine (ADR-0009, PR B2).
 *
 * Owns registration, the FIFO delivery queue and its microtask drain,
 * write-driven notification (doc + query), metadata acks, and the
 * rules-flip / auth-change re-evaluation entry points. Rules-gated reads
 * are NOT its concern — they arrive through the injected
 * {@link ListenerDispatchHost} slice (they move to RulesReadEngine in
 * PR B3). Trigger attribution reads the injected {@link TriggerScope};
 * observational events dispatch through the injected
 * {@link FirestoreEventBus} (payload building for the purely
 * listener-owned channels — delivery, suppressed, lifecycle,
 * snapshotError — lives here, since no other engine path emits them).
 */
import type { DocumentData } from './local-state.js';
import type { FirestoreSimError } from './errors.js';
import type {
  ListenerAuth,
  ListenerRecord,
  QueryConstraintInput,
  SnapshotCallback,
  SnapshotErrorCallback,
  SnapshotListenerOptions,
  SnapshotTarget,
} from './snapshot-listeners.js';
import {
  buildDocumentSnapshot,
  buildQuerySnapshot,
  SANDBOX_METADATA,
  SANDBOX_METADATA_PENDING,
} from './snapshot-listeners.js';
import { docDataEqual, anyPathInCollection } from './listener-delivery.js';
import { nextRequestEventId } from './request-events.js';
import type { FirestoreEventBus } from './event-bus.js';
import type { TriggerScope } from './trigger-scope.js';
import type {
  SnapshotDeliveryEvent,
  SnapshotSuppressedEvent,
  ListenerLifecycleEvent,
} from '../../sandbox/types/events.js';

/**
 * The engine capabilities listener dispatch needs — nothing more. Both are
 * rules-gated silent reads (no event-log append); they stay on the engine
 * facade until PR B3 moves them into RulesReadEngine. Implementations may
 * throw `SimulatorUnsupportedError`, which propagates to the caller
 * unchanged (an unsupported rule is a sandbox limitation worth surfacing
 * verbatim, not silently rerouting through `errorCallback`).
 */
export interface ListenerDispatchHost {
  silentReadDoc(
    path: string,
    auth: ListenerAuth,
    bypassRules?: boolean,
  ): { allowed: true; data: DocumentData | null } | { allowed: false; error: FirestoreSimError };
  silentReadCollection(
    collection: string,
    auth: ListenerAuth,
    constraints?: QueryConstraintInput,
    bypassRules?: boolean,
  ):
    | { allowed: true; docs: { path: string; data: DocumentData }[] }
    | { allowed: false; error: FirestoreSimError };
}

export class ListenerDispatch {
  /**
   * Active `onSnapshot` listeners. Stored as a flat `Map<id, record>`
   * per the implementation plan; query-canonicalization-based dedup
   * (production's `EventManager` shape) is layered on later when caching
   * actually saves work — see source survey section 2 for the eventual
   * target shape. Each record carries its own target so future slices can
   * scan and group on demand without restructuring the registry first.
   */
  private snapshotListeners: Map<string, ListenerRecord> = new Map();
  private nextListenerId = 0;

  /**
   * Deferred listener deliveries — the shared delivery scheduler (items
   * 3 + 5). Production never invokes an `onSnapshot` callback synchronously
   * on the registering/writing stack: the initial snapshot arrives after
   * the listen round-trip (COMPAT firestore#80 — "asynchronous, never
   * during register"), and a local write's echo + server ack arrive on the
   * async event queue (firestore#85). The sandbox mirrors that by enqueuing
   * every user-facing delivery here and draining it off-stack, on a
   * `queueMicrotask` boundary — which satisfies the "asynchronous" contract
   * without a macrotask's extra latency (the prototype in the deep-divergence
   * review measured identical behavior for micro- vs macro-task deferral).
   *
   * Per-listener FIFO order is preserved: deliveries enqueued *during* a
   * drain — a callback that itself writes, or the item-3 metadata ack a
   * write echo schedules — are appended and drained in the same pass, so a
   * write settles fully before control returns to the microtask loop.
   */
  private deliveryQueue: Array<() => void> = [];
  private deliveryScheduled = false;

  constructor(
    private readonly events: FirestoreEventBus,
    private readonly triggerScope: TriggerScope,
    private readonly host: ListenerDispatchHost,
  ) {}

  // ═══ Listener-owned event payloads ═══

  private emitSnapshotDelivery(input: {
    listenerId: string;
    target: SnapshotDeliveryEvent['target'];
    auth: ListenerAuth;
    addedCount: number;
    modifiedCount: number;
    removedCount: number;
    size: number;
    sample?: { docs: Array<{ path: string; data: Record<string, unknown> | null }> };
    triggeredBy?: { method: string; path: string };
  }): void {
    if (!this.events.delivery.hasSubscribers) return;
    const event: SnapshotDeliveryEvent = {
      kind: 'snapshot_delivery',
      id: nextRequestEventId().replace(/^req-/, 'snd-'),
      at: Date.now(),
      listenerId: input.listenerId,
      target: input.target,
      auth: input.auth
        ? { uid: input.auth.uid, ...(input.auth.token ? { token: input.auth.token } : {}) }
        : null,
      addedCount: input.addedCount,
      modifiedCount: input.modifiedCount,
      removedCount: input.removedCount,
      size: input.size,
      ...(input.sample ? { sample: input.sample } : {}),
      ...(input.triggeredBy ? { triggeredBy: input.triggeredBy } : {}),
    };
    this.events.delivery.emit(event);
  }

  private emitSnapshotSuppressed(input: {
    listenerId: string;
    target: SnapshotSuppressedEvent['target'];
    auth: ListenerAuth;
    triggeredBy?: { method: string; path: string };
  }): void {
    if (!this.events.suppressed.hasSubscribers) return;
    const event: SnapshotSuppressedEvent = {
      kind: 'snapshot_suppressed',
      id: nextRequestEventId().replace(/^req-/, 'sup-'),
      at: Date.now(),
      listenerId: input.listenerId,
      target: input.target,
      auth: input.auth
        ? { uid: input.auth.uid, ...(input.auth.token ? { token: input.auth.token } : {}) }
        : null,
      reason: 'no-op',
      ...(input.triggeredBy ? { triggeredBy: input.triggeredBy } : {}),
    };
    this.events.suppressed.emit(event);
  }

  private emitLifecycle(input: {
    phase: 'listener_attach' | 'listener_detach';
    listenerId: string;
    target: ListenerLifecycleEvent['target'];
    auth: ListenerAuth;
  }): void {
    if (!this.events.lifecycle.hasSubscribers) return;
    const event: ListenerLifecycleEvent = {
      kind: input.phase,
      id: nextRequestEventId().replace(/^req-/, 'lc-'),
      at: Date.now(),
      listenerId: input.listenerId,
      target: input.target,
      auth: input.auth
        ? { uid: input.auth.uid, ...(input.auth.token ? { token: input.auth.token } : {}) }
        : null,
    };
    this.events.lifecycle.emit(event);
  }

  private emitSnapshotError(
    err: FirestoreSimError,
    target: SnapshotTarget,
    listenerId: string,
  ): void {
    this.events.snapshotError.emit(err, target, listenerId);
  }

  // ═══ Registration (Slices 1+2) ═══

  /**
   * Register a snapshot listener. Returns an `Unsubscribe` function
   * matching the Web SDK's contract — a zero-arg call that detaches
   * the listener. Idempotent: calling the returned function more than
   * once after the first detach is a no-op.
   *
   * The initial snapshot is delivered off-stack through the delivery
   * scheduler, never synchronously during register. Denied reads invoke
   * `errorCallback` and mark the listener `errored` (no further
   * notifications).
   *
   * `auth` is captured at registration so notifications later evaluate
   * rules under the auth that subscribed — not whatever auth happens
   * to be active when a write triggers the dispatch.
   */
  addSnapshotListener(
    target: SnapshotTarget,
    callback: SnapshotCallback,
    options: SnapshotListenerOptions = {},
    auth: ListenerAuth = null,
    errorCallback?: SnapshotErrorCallback,
    /**
     * `true` when the registering Firestore handle was a `sandbox-live`
     * (`getFirestore(sandbox)`) target — its identity follows
     * `sandbox.currentUser`, so this listener re-evaluates on a
     * `currentUser` change (see {@link reevaluateLiveListeners}).
     * `false` (default) for frozen-ctx (`getFirestore(ctx)`) listeners,
     * which stay pinned to the auth they captured at registration.
     */
    followsCurrentUser = false,
    /** Preserve the admin lens for the listener's full lifetime. */
    bypassRules = false,
    /** Named app session identity; undefined means the ambient session. */
    authScope?: object,
  ): () => void {
    const id = String(this.nextListenerId++);
    const record: ListenerRecord = {
      id,
      target,
      callback,
      auth,
      bypassRules,
      followsCurrentUser,
      ...(authScope ? { authScope } : {}),
      options,
      currentSnapshot: undefined,
      errored: false,
      ...(errorCallback ? { errorCallback } : {}),
    };
    this.snapshotListeners.set(id, record);

    // Issue #307 — emit lifecycle BEFORE the initial fire so observers
    // see attach → delivery in causal order.
    this.emitLifecycle({
      phase: 'listener_attach',
      listenerId: id,
      target: target.kind === 'doc'
        ? { kind: 'doc', path: target.path }
        : {
            kind: 'query',
            collection: target.collection,
            ...(target.constraints?.activityQuery
              ? { query: target.constraints.activityQuery }
              : {}),
          },
      auth,
    });

    // Items 3 + 5 — the initial snapshot is delivered off-stack through the
    // delivery scheduler, never synchronously during register. Production's
    // event queue schedules even a *cached* initial event asynchronously
    // (COMPAT firestore#80: "asynchronous, never during register"), so the
    // register-then-read-synchronously agent pattern that returns `undefined`
    // on prod also returns `undefined` here — the sandbox no longer trains
    // users into a pattern prod breaks. The unsubscribe-before-drain guard
    // mirrors prod: a listener detached before its first fire never sees one.
    // Errors still route through the listener's `errorCallback` (inside
    // `fireInitialSnapshot`), never thrown out of `addSnapshotListener`.
    this.scheduleDelivery(() => {
      if (!this.snapshotListeners.has(id)) return;
      this.fireInitialSnapshot(record);
    });

    return () => {
      const stillRegistered = this.snapshotListeners.has(id);
      this.snapshotListeners.delete(id);
      // Only emit detach if the listener was actually registered when
      // the unsubscribe was called. Idempotent calls and listeners
      // dropped by `reset()` don't double-emit.
      if (stillRegistered) {
        this.emitLifecycle({
          phase: 'listener_detach',
          listenerId: id,
          target: target.kind === 'doc'
            ? { kind: 'doc', path: target.path }
            : {
                kind: 'query',
                collection: target.collection,
                ...(target.constraints?.activityQuery
                  ? { query: target.constraints.activityQuery }
                  : {}),
              },
          auth,
        });
      }
    };
  }

  /**
   * Compute and deliver the initial snapshot for a freshly-registered
   * listener. Reads under the listener's `auth` and respects the
   * deployed rules — denied reads route to `errorCallback` and mark
   * the record `errored`. Splits doc vs query targets along the same
   * seam the engine's `execute` uses, but does **not** append to the
   * event log: listener reads are bookkeeping, not user-visible
   * operations, and would otherwise drown the event log under any
   * non-trivial UI.
   */
  private fireInitialSnapshot(record: ListenerRecord): void {
    if (record.target.kind === 'doc') {
      const result = this.host.silentReadDoc(
        record.target.path,
        record.auth,
        record.bypassRules,
      );
      if (!result.allowed) {
        this.markErrored(record, result.error);
        return;
      }
      const snap = buildDocumentSnapshot(record.target.path, result.data);
      record.currentSnapshot = snap;
      record.currentDocData = result.data;
      try {
        record.callback(snap);
      } catch {
        /* swallow — a faulty consumer callback must not destabilize the
         * simulator. */
      }
      // Issue #307 — initial fire counts as a delivery. No triggeredBy
      // because there was no user op that caused this; the listener
      // just attached.
      this.emitSnapshotDelivery({
        listenerId: record.id,
        target: { kind: 'doc', path: record.target.path },
        auth: record.auth,
        addedCount: result.data !== null ? 1 : 0,
        modifiedCount: 0,
        removedCount: 0,
        size: result.data !== null ? 1 : 0,
        sample: { docs: [{ path: record.target.path, data: result.data }] },
      });
      return;
    }

    // Query target.
    const result = this.host.silentReadCollection(
      record.target.collection,
      record.auth,
      record.target.constraints,
      record.bypassRules,
    );
    if (!result.allowed) {
      this.markErrored(record, result.error);
      return;
    }
    const snap = buildQuerySnapshot(
      { path: record.target.collection },
      result.docs,
      { excludesMetadataChanges: !record.options.includeMetadataChanges },
    );
    record.currentSnapshot = snap;
    record.currentDocs = result.docs;
    try {
      record.callback(snap);
    } catch {
      /* swallow — see above */
    }
    this.emitSnapshotDelivery({
      listenerId: record.id,
      target: { kind: 'query', collection: record.target.collection },
      auth: record.auth,
      // Initial fire: every doc surfaces as `added`.
      addedCount: result.docs.length,
      modifiedCount: 0,
      removedCount: 0,
      size: result.docs.length,
      sample: { docs: result.docs.map((d) => ({ path: d.path, data: d.data })) },
    });
  }

  // ═══ Delivery scheduler (items 3 + 5) ═══

  /**
   * Enqueue a listener delivery and ensure an off-stack drain is pending.
   * See {@link deliveryQueue}.
   */
  private scheduleDelivery(deliver: () => void): void {
    this.deliveryQueue.push(deliver);
    if (this.deliveryScheduled) return;
    this.deliveryScheduled = true;
    queueMicrotask(() => this.drainDeliveries());
  }

  /**
   * Enqueue a write-driven delivery, restoring the triggering op while it
   * runs so listener-origin RequestEvents / delivery events still attribute
   * to the write (`triggeredBy`) even though the callback now fires off the
   * writing stack. See {@link TriggerScope}.
   */
  private scheduleTriggeredDelivery(
    trigger: { method: string; path: string } | undefined,
    deliver: () => void,
  ): void {
    this.scheduleDelivery(() => this.triggerScope.run(trigger, deliver));
  }

  /**
   * Drain queued deliveries in FIFO order. A delivery may enqueue more (a
   * callback that writes; the item-3 metadata ack a write echo schedules) —
   * those are appended and drained in the same pass.
   */
  private drainDeliveries(): void {
    this.deliveryScheduled = false;
    while (this.deliveryQueue.length > 0) {
      const deliver = this.deliveryQueue.shift()!;
      deliver();
    }
  }

  /**
   * Synchronously deliver all pending snapshot fires. Test-only seam:
   * production consumers observe deliveries via the microtask drain, but a
   * synchronous test body calls this to settle the queue deterministically
   * before asserting fire counts / snapshot contents. Idempotent — a no-op
   * on an empty queue, and safe when a microtask drain is also pending (that
   * drain then finds the queue already empty).
   */
  flushListeners(): void {
    this.drainDeliveries();
  }

  // ═══ Slice 3 — change-driven notification ═══

  /**
   * Walk every active snapshot listener and fire those whose target
   * intersects `touchedPaths`. Called by the write-path commit hooks
   * — `execute` (single write) and the two `applyBatch` call-sites
   * (batch + transaction). Suppresses no-op snapshots per findings section 5
   * (View-level suppression rather than `isEqual`): doc listeners only
   * fire when the underlying data shape changes; query listeners only
   * fire when the change list is non-empty.
   *
   * Iteration walks a snapshotted list of records — a callback is
   * allowed to add or remove listeners (StrictMode + HMR routinely do)
   * and we must not iterate a mutating Map.
   *
   * Items 3 + 5 — each per-listener fire is enqueued on the delivery
   * scheduler rather than run inline, so the write echo lands off the
   * writing stack (like prod's async event queue) and stays ordered behind
   * any still-pending initial fire for the same listener. The errored /
   * unsubscribe checks are re-run at delivery time because a listener may
   * detach or error between this write and the drain.
   */
  notifyListenersForPaths(touchedPaths: ReadonlySet<string>): void {
    if (touchedPaths.size === 0) return;
    if (this.snapshotListeners.size === 0) return;
    // Capture the triggering op now; the deliveries run off-stack, by which
    // time the trigger scope has been restored to the microtask loop's state.
    const trigger = this.triggerScope.current();
    const records = Array.from(this.snapshotListeners.values());
    for (const record of records) {
      this.scheduleTriggeredDelivery(trigger, () => {
        if (!this.snapshotListeners.has(record.id)) return;
        if (record.errored) return;
        if (record.target.kind === 'doc') {
          this.notifyDocListener(record, touchedPaths);
        } else {
          this.notifyQueryListener(record, touchedPaths);
        }
      });
    }
  }

  private notifyDocListener(record: ListenerRecord, touchedPaths: ReadonlySet<string>): void {
    if (record.target.kind !== 'doc') return;
    if (!touchedPaths.has(record.target.path)) return;

    const result = this.host.silentReadDoc(
      record.target.path,
      record.auth,
      record.bypassRules,
    );
    if (!result.allowed) {
      this.markErrored(record, result.error);
      return;
    }

    // Suppression: identical underlying data (existence + shape) ⇒ no
    // fire. Production's View suppresses by absence rather than by
    // building-then-comparing snapshots; we approximate the same shape
    // by comparing the raw data we'd hand to `buildDocumentSnapshot`.
    const prev = record.currentDocData ?? null;
    if (docDataEqual(prev, result.data)) {
      // Issue #307 — surface the suppressed re-eval so inspector-style
      // consumers can answer "the listener woke up but had nothing to
      // deliver".
      this.emitSnapshotSuppressed({
        listenerId: record.id,
        target: { kind: 'doc', path: record.target.path },
        auth: record.auth,
        ...(this.triggerScope.current() ? { triggeredBy: this.triggerScope.current() } : {}),
      });
      return;
    }

    // Item 3 — the local write echo carries hasPendingWrites:true (prod's
    // optimistic local fire, delivered before the server round-trip). The
    // settled server ack (hasPendingWrites:false) is scheduled below, but
    // only includeMetadataChanges listeners observe it — a default listener's
    // last-seen snapshot stays `pending:true` (COMPAT firestore#85).
    const path = record.target.path;
    const snap = buildDocumentSnapshot(path, result.data, SANDBOX_METADATA_PENDING);
    record.currentSnapshot = snap;
    record.currentDocData = result.data;
    // Compute change shape for the delivery event. Doc listeners deliver
    // exactly one of added / modified / removed per fire.
    const wasExists = prev !== null;
    const isExists = result.data !== null;
    const addedCount = !wasExists && isExists ? 1 : 0;
    const removedCount = wasExists && !isExists ? 1 : 0;
    const modifiedCount = wasExists && isExists ? 1 : 0;
    try {
      record.callback(snap);
    } catch {
      /* swallow — see fireInitialSnapshot doc */
    }
    // Emit delivery AFTER the user callback runs so subscribers see
    // the same ordering as the user code: callback first, observer second.
    this.emitSnapshotDelivery({
      listenerId: record.id,
      target: { kind: 'doc', path },
      auth: record.auth,
      addedCount,
      modifiedCount,
      removedCount,
      size: isExists ? 1 : 0,
      sample: { docs: [{ path, data: result.data }] },
      ...(this.triggerScope.current() ? { triggeredBy: this.triggerScope.current() } : {}),
    });
    this.scheduleDocMetadataAck(record, path, result.data);
  }

  /**
   * Item 3 — schedule the server-ack fire that follows a write echo. Only
   * fires for includeMetadataChanges listeners (default listeners never see
   * the metadata-only ack; their snapshot stays `pending:true`). Re-delivers
   * the just-echoed data with `hasPendingWrites:false`, as a metadata-only
   * change (no added/modified/removed). Rides the delivery scheduler so it
   * lands off the echo's stack, matching prod's async ack rather than a
   * synchronous same-tick fire. `data` is captured from the echo so a later
   * write can't retroactively change what this ack reports. COMPAT firestore#85.
   */
  private scheduleDocMetadataAck(
    record: ListenerRecord,
    path: string,
    data: DocumentData | null,
  ): void {
    if (!record.options.includeMetadataChanges) return;
    this.scheduleTriggeredDelivery(this.triggerScope.current(), () => {
      if (!this.snapshotListeners.has(record.id)) return;
      if (record.errored) return;
      const ack = buildDocumentSnapshot(path, data, SANDBOX_METADATA);
      record.currentSnapshot = ack;
      try {
        record.callback(ack);
      } catch {
        /* swallow — see fireInitialSnapshot doc */
      }
      this.emitSnapshotDelivery({
        listenerId: record.id,
        target: { kind: 'doc', path },
        auth: record.auth,
        addedCount: 0,
        modifiedCount: 0,
        removedCount: 0,
        size: data !== null ? 1 : 0,
        sample: { docs: [{ path, data }] },
        ...(this.triggerScope.current() ? { triggeredBy: this.triggerScope.current() } : {}),
      });
    });
  }

  private notifyQueryListener(record: ListenerRecord, touchedPaths: ReadonlySet<string>): void {
    if (record.target.kind !== 'query') return;
    // Cheap pre-filter: if no touched path lives in this collection,
    // skip the rules eval entirely. The silent collection read's
    // query-proof gate handles read-side visibility; this filter is
    // purely a write-path optimization.
    if (!anyPathInCollection(touchedPaths, record.target.collection)) return;

    const result = this.host.silentReadCollection(
      record.target.collection,
      record.auth,
      record.target.constraints,
      record.bypassRules,
    );
    if (!result.allowed) {
      this.markErrored(record, result.error);
      return;
    }

    const collection = record.target.collection;
    const prevDocs = record.currentDocs ?? [];
    // Item 3 — the write echo carries hasPendingWrites:true; the settled ack
    // (scheduled below for includeMetadataChanges listeners) carries false.
    const snap = buildQuerySnapshot(
      { path: collection },
      result.docs,
      { excludesMetadataChanges: !record.options.includeMetadataChanges },
      prevDocs,
      SANDBOX_METADATA_PENDING,
    );
    // Suppression: empty change set ⇒ nothing observable changed for
    // this listener (e.g., a write that landed under a different
    // collection but tripped the cheap pre-filter, or a write whose
    // post-image equals its pre-image). Match findings section 5.
    const changes = snap.docChanges();
    if (changes.length === 0) {
      this.emitSnapshotSuppressed({
        listenerId: record.id,
        target: { kind: 'query', collection },
        auth: record.auth,
        ...(this.triggerScope.current() ? { triggeredBy: this.triggerScope.current() } : {}),
      });
      return;
    }

    record.currentSnapshot = snap;
    record.currentDocs = result.docs;
    let addedCount = 0, modifiedCount = 0, removedCount = 0;
    for (const c of changes) {
      if (c.type === 'added') addedCount++;
      else if (c.type === 'modified') modifiedCount++;
      else if (c.type === 'removed') removedCount++;
    }
    try {
      record.callback(snap);
    } catch {
      /* swallow — see fireInitialSnapshot doc */
    }
    this.emitSnapshotDelivery({
      listenerId: record.id,
      target: { kind: 'query', collection },
      auth: record.auth,
      addedCount,
      modifiedCount,
      removedCount,
      size: result.docs.length,
      sample: { docs: result.docs.map((d) => ({ path: d.path, data: d.data })) },
      ...(this.triggerScope.current() ? { triggeredBy: this.triggerScope.current() } : {}),
    });
    this.scheduleQueryMetadataAck(record, collection, result.docs);
  }

  /**
   * Item 3 — query counterpart of {@link scheduleDocMetadataAck}. Re-delivers
   * the echoed doc set with `hasPendingWrites:false` as a metadata-only change
   * (no added/modified/removed — `prevDocs` equals the current docs), for
   * includeMetadataChanges listeners only. COMPAT firestore#85.
   */
  private scheduleQueryMetadataAck(
    record: ListenerRecord,
    collection: string,
    docs: { path: string; data: DocumentData }[],
  ): void {
    if (!record.options.includeMetadataChanges) return;
    this.scheduleTriggeredDelivery(this.triggerScope.current(), () => {
      if (!this.snapshotListeners.has(record.id)) return;
      if (record.errored) return;
      const ack = buildQuerySnapshot(
        { path: collection },
        docs,
        { excludesMetadataChanges: false },
        docs,
        SANDBOX_METADATA,
      );
      record.currentSnapshot = ack;
      try {
        record.callback(ack);
      } catch {
        /* swallow — see fireInitialSnapshot doc */
      }
      this.emitSnapshotDelivery({
        listenerId: record.id,
        target: { kind: 'query', collection },
        auth: record.auth,
        addedCount: 0,
        modifiedCount: 0,
        removedCount: 0,
        size: docs.length,
        sample: { docs: docs.map((d) => ({ path: d.path, data: d.data })) },
        ...(this.triggerScope.current() ? { triggeredBy: this.triggerScope.current() } : {}),
      });
    });
  }

  /**
   * Mark a listener as errored and fan the error out to two channels:
   *   1. The listener's own `errorCallback` (per-listener handler the
   *      Web SDK consumer registered via `onSnapshot(next, error)`).
   *   2. Every env-level `onSnapshotError` subscriber (Slice 7) — the
   *      playground UI surfaces stream errors here without each
   *      listener needing to register its own toast handler.
   *
   * Fan-out is unconditional even when `errorCallback` is missing: the
   * env-level channel is the catch-all so the host environment can
   * surface errors from listeners that didn't supply their own handler.
   */
  private markErrored(record: ListenerRecord, error: FirestoreSimError): void {
    record.errored = true;
    this.emitSnapshotError(error, record.target, record.id);
    if (!record.errorCallback) return;
    try {
      record.errorCallback(error);
    } catch {
      /* swallow — observational; see EventChannel doc */
    }
  }

  // ═══ Slice 6 — rules-flip / auth-change re-evaluation ═══

  /**
   * Walk every active listener and recompute its snapshot under the
   * current rules. Called by `deployRules` after a successful rules swap
   * (Slice 6 section 4.1). Iteration follows the same
   * snapshot-then-skip-orphans pattern as {@link notifyListenersForPaths}
   * — a callback may add or remove listeners (StrictMode + HMR both
   * routinely do this), and the dispatch loop must not iterate a
   * mutating Map.
   */
  reEvaluateAllListeners(): void {
    if (this.snapshotListeners.size === 0) return;
    const records = Array.from(this.snapshotListeners.values());
    for (const record of records) {
      if (!this.snapshotListeners.has(record.id)) continue;
      if (record.target.kind === 'doc') {
        this.reEvaluateDocListener(record);
      } else {
        this.reEvaluateQueryListener(record);
      }
    }
  }

  /**
   * Re-evaluate every LIVE listener against a new session auth.
   *
   * Called when the sandbox's `currentUser` changes (sign-out / sign-in
   * as a different user). Production re-establishes the listen stream on
   * a session auth change — an auth-gated listener loses access on
   * sign-out and re-reads under the new identity on sign-in. The sandbox
   * matches that here: for each listener with `followsCurrentUser`, we
   * set `record.auth = newAuth` and re-run the SAME per-listener
   * evaluation `deployRules` uses ({@link reEvaluateDocListener} /
   * {@link reEvaluateQueryListener}) — which re-reads under the new auth
   * and flips allowed↔denied (delivering a fresh snapshot, or marking
   * the listener errored with `permission-denied` when the new auth
   * can't read).
   *
   * Frozen-ctx listeners (`followsCurrentUser === false`) are left
   * untouched — they stay pinned to the identity chosen at
   * `getFirestore(ctx)` time. WRITE-driven re-eval is unaffected: a
   * write by another user still re-evaluates each listener against ITS
   * OWN captured `auth` (this method only runs on auth change, and only
   * touches live listeners' captured auth).
   *
   * No-op when there are no live listeners. Iteration follows the same
   * snapshot-then-skip-orphans pattern as {@link notifyListenersForPaths}
   * — a callback may add or remove listeners during dispatch.
   */
  reevaluateLiveListeners(newAuth: ListenerAuth, authScope?: object): void {
    if (this.snapshotListeners.size === 0) return;
    const records = Array.from(this.snapshotListeners.values());
    for (const record of records) {
      if (!record.followsCurrentUser) continue;
      if (record.authScope !== authScope) continue;
      if (!this.snapshotListeners.has(record.id)) continue;
      // Re-capture the session's new auth, then re-read under it. This is
      // the live-listener counterpart to prod re-establishing the stream
      // under the new identity.
      record.auth = newAuth;
      if (record.target.kind === 'doc') {
        this.reEvaluateDocListener(record);
      } else {
        this.reEvaluateQueryListener(record);
      }
    }
  }

  /**
   * Doc-listener re-evaluation. Three flip cases matter:
   *   - Allowed → denied: mark errored (unless already errored, in which
   *     case the error is not re-delivered — matches production's
   *     once-per-stream error contract).
   *   - Errored → allowed: clear `errored` and fire as an initial
   *     snapshot (the listener gets a fresh baseline; suppression cannot
   *     apply because there is no comparable `currentDocData` from the
   *     errored state).
   *   - Allowed → allowed: behaves like a write-driven re-fire — diff
   *     against `currentDocData` and suppress if unchanged.
   */
  private reEvaluateDocListener(record: ListenerRecord): void {
    if (record.target.kind !== 'doc') return;
    const result = this.host.silentReadDoc(
      record.target.path,
      record.auth,
      record.bypassRules,
    );
    if (!result.allowed) {
      if (record.errored) return;
      this.markErrored(record, result.error);
      return;
    }
    if (record.errored) {
      record.errored = false;
      const snap = buildDocumentSnapshot(record.target.path, result.data);
      record.currentSnapshot = snap;
      record.currentDocData = result.data;
      try {
        record.callback(snap);
      } catch {
        /* swallow — see fireInitialSnapshot doc */
      }
      return;
    }
    const prev = record.currentDocData ?? null;
    if (docDataEqual(prev, result.data)) return;
    const snap = buildDocumentSnapshot(record.target.path, result.data);
    record.currentSnapshot = snap;
    record.currentDocData = result.data;
    try {
      record.callback(snap);
    } catch {
      /* swallow — see fireInitialSnapshot doc */
    }
  }

  /**
   * Query-listener re-evaluation. Flip semantics mirror the doc path:
   * the silent collection read re-runs the query-proof gate + `list`
   * rule under the new rules — a query that flipped unprovable/denied
   * surfaces as a stream error, one that flipped allowed re-delivers,
   * and the diff against `currentDocs` is computed by the same
   * `buildQuerySnapshot` path the write-driven notifier uses.
   */
  private reEvaluateQueryListener(record: ListenerRecord): void {
    if (record.target.kind !== 'query') return;
    const result = this.host.silentReadCollection(
      record.target.collection,
      record.auth,
      record.target.constraints,
      record.bypassRules,
    );
    if (!result.allowed) {
      if (record.errored) return;
      this.markErrored(record, result.error);
      return;
    }
    if (record.errored) {
      record.errored = false;
      // No prevDocs — every readable doc surfaces as `added`, matching
      // initial-fire semantics. The errored state had no comparable
      // baseline, so a clean reset is the correct contract.
      const snap = buildQuerySnapshot(
        { path: record.target.collection },
        result.docs,
        { excludesMetadataChanges: !record.options.includeMetadataChanges },
      );
      record.currentSnapshot = snap;
      record.currentDocs = result.docs;
      try {
        record.callback(snap);
      } catch {
        /* swallow — see fireInitialSnapshot doc */
      }
      return;
    }
    const prevDocs = record.currentDocs ?? [];
    const snap = buildQuerySnapshot(
      { path: record.target.collection },
      result.docs,
      { excludesMetadataChanges: !record.options.includeMetadataChanges },
      prevDocs,
    );
    const changes = snap.docChanges();
    if (changes.length === 0) return;
    record.currentSnapshot = snap;
    record.currentDocs = result.docs;
    try {
      record.callback(snap);
    } catch {
      /* swallow — see fireInitialSnapshot doc */
    }
  }

  // ═══ Lifecycle ═══

  /**
   * Test seam — exposes registry size without leaking the records.
   */
  getSnapshotListenerCount(): number {
    return this.snapshotListeners.size;
  }

  /**
   * Drop every registered listener and any queued-but-undelivered fires,
   * so a disposed engine can't invoke an outgoing consumer's callback on
   * a later microtask drain. Idempotent. The engine facade's `dispose()`
   * additionally clears the event bus's subscribers.
   */
  dispose(): void {
    this.snapshotListeners.clear();
    this.deliveryQueue.length = 0;
    this.deliveryScheduled = false;
  }
}
