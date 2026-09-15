import { firestoreReadUsage, databaseReadUsage, firestoreWriteUsage, type UsageEvidence } from './usage-evidence.js';
import type { ListenerOwner } from '../types/events.js';
import type { ServiceIndexQuery } from '../../rules/indexes/service-query.js';
import { sdkObservation, type SdkObservation } from './sdk-observation.js';

/** Page-side SDK evidence. Transport messages are deliberately not deliveries. */
export interface SdkActivitySource {
  readonly service: 'firestore' | 'database' | 'storage';
  readonly target: string;
  /** Canonical adapter descriptor, used only for identity, never exposed in records. */
  readonly key: string;
  readonly isQuery?: boolean;
  readonly indexQuery?: ServiceIndexQuery;
}

export interface SdkActivityRecord {
  readonly id: string;
  readonly appId: string;
  readonly sourceId: string;
  readonly service: SdkActivitySource['service'];
  readonly target: string;
  readonly isQuery: boolean;
  readonly indexQuery?: ServiceIndexQuery;
  readonly method: string;
  readonly kind: 'operation' | 'subscription';
  readonly status: 'pending' | 'active' | 'completed' | 'failed' | 'closed';
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly deliveryCount: number;
  readonly lastDeliveryAt?: number;
  readonly lastProgressAt?: number;
  readonly owners: readonly ListenerOwner[];
  /** Optional bridge identity. It is not the logical activity id. */
  readonly transportId?: string;
}

export interface SdkActivityHandle {
  readonly id: string;
  /** Call immediately before handing a successful result to application code. */
  delivered(snapshot?: unknown, usage?: UsageEvidence): void;
  /** A progress callback, never a result or rate observation. */
  progress(): void;
  complete(usage?: UsageEvidence): void;
  fail(): void;
  close(): void;
  transport(id: string): void;
}

export interface SdkActivityEvent {
  readonly phase: 'start' | 'delivery' | 'end' | 'remove' | 'transport' | 'progress';
  readonly record: SdkActivityRecord;
  readonly usage?: UsageEvidence;
}

interface AppIdentity {
  id: string;
  sources: Map<string, { id: string; uses: number }>;
}

/**
 * Lifecycle only: no DOM, payloads, callback wrappers, Promise chains, or
 * backend events. Adapters report at their existing public execution boundary.
 */
export function createSdkActivityJournal(options: {
  now?: () => number;
  /** Independent of the sandbox clock and wall-clock adjustments. */
  monotonicNow?: () => number;
  retentionMs?: number;
  maxCompleted?: number;
  /** Protect completed deliveries until the page's render window has elapsed. */
  correlationWindowMs?: number;
} = {}) {
  const now = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const correlationWindowMs = options.correlationWindowMs ?? 250;
  const retentionMs = Math.max(options.retentionMs ?? 30_000, correlationWindowMs);
  const maxCompleted = options.maxCompleted ?? 100;
  const apps = new WeakMap<object, AppIdentity>();
  const records = new Map<string, SdkActivityRecord>();
  const releaseSources = new Map<string, () => void>();
  const subscribers = new Set<(event: SdkActivityEvent) => void>();
  const observers = new Set<(observation: SdkObservation) => void>();
  const observations: Array<{ event: SdkObservation; observers: Array<(event: SdkObservation) => void> }> = [];
  let observationSequence = 0;
  let observing = false;
  let appSerial = 0;
  let sourceSerial = 0;
  let activitySerial = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let registrationId: string | undefined;
  let silenced = false;
  let pruning = false;

  function notify(phase: SdkActivityEvent['phase'], record: SdkActivityRecord, usage?: UsageEvidence): void {
    const observation = sdkObservation({ phase, record, usage }, now(), monotonicNow(), observationSequence + 1);
    if (observation) {
      observationSequence++;
      observations.push({ event: observation, observers: [...observers] });
    }
    // An observer may synchronously cause another SDK call. Finish delivering
    // this observation before delivering the next to any other observer.
    if (!observing) {
      observing = true;
      try {
        while (observations.length) {
          const next = observations.shift()!;
          for (const observer of next.observers) {
            try { observer(next.event); } catch { /* Diagnostics cannot alter SDK behavior. */ }
          }
        }
      } finally {
        observing = false;
      }
    }
    for (const subscriber of [...subscribers]) {
      try { subscriber({ phase, record }); } catch { /* Diagnostics cannot alter SDK behavior. */ }
    }
  }

  function remove(record: SdkActivityRecord): void {
    if (!records.delete(record.id)) return;
    releaseSources.get(record.id)?.();
    releaseSources.delete(record.id);
    notify('remove', record);
  }

  function prune(): void {
    if (pruning) return;
    pruning = true;
    try {
      clearTimeout(timer);
      timer = undefined;
      const ended = [...records.values()].filter(record => record.endedAt !== undefined)
        .sort((a, b) => a.endedAt! - b.endedAt!);
      const expiredBefore = now() - retentionMs;
      while (ended.length && (
        ended[0].endedAt! <= expiredBefore
        || (ended.length > maxCompleted && ended[0].endedAt! <= now() - correlationWindowMs)
      )) {
        remove(ended.shift()!);
      }
      if (ended.length && !disposed) {
        const delay = ended.length > maxCompleted ? correlationWindowMs : retentionMs;
        timer = setTimeout(prune, Math.max(1, ended[0].endedAt! + delay - now()));
        // Retention must not keep a Node process alive.
        if (typeof timer === 'object' && 'unref' in timer) timer.unref();
      }
    } finally { pruning = false; }
  }

  return {
    /** Host-side mirror calls implement transport, not another public SDK call. */
    silence<T>(execute: () => T): T {
      const previous = silenced;
      silenced = true;
      try { return execute(); } finally { silenced = previous; }
    },
    /** Synchronous registration scope, solely to join backend attach evidence. */
    registering<T>(activity: SdkActivityHandle, register: () => T): T {
      const previous = registrationId;
      registrationId = activity.id;
      try { return register(); } finally { registrationId = previous; }
    },
    registrationId(): string | undefined { return registrationId; },
    begin(input: {
      app: object;
      source: SdkActivitySource;
      method: string;
      kind: SdkActivityRecord['kind'];
      owners?: readonly ListenerOwner[];
      transportId?: string;
    }): SdkActivityHandle {
      if (disposed || silenced) return {
        id: '', delivered() {}, progress() {}, complete() {}, fail() {}, close() {}, transport() {},
      };
      let app = apps.get(input.app);
      if (!app) {
        app = { id: `app-${++appSerial}`, sources: new Map() };
        apps.set(input.app, app);
      }
      const key = JSON.stringify([input.source.service, input.source.key]);
      let source = app.sources.get(key);
      if (!source) {
        source = { id: `${app.id}/source-${++sourceSerial}`, uses: 0 };
        app.sources.set(key, source);
      }
      ++source.uses;
      const id = `${app.id}/activity-${++activitySerial}`;
      const record: SdkActivityRecord = Object.freeze({
        id, appId: app.id, sourceId: source.id,
        service: input.source.service, target: input.source.target,
        isQuery: input.source.isQuery ?? false,
        ...(input.source.indexQuery ? { indexQuery: structuredClone(input.source.indexQuery) } : {}),
        method: input.method, kind: input.kind,
        status: input.kind === 'operation' ? 'pending' : 'active',
        startedAt: now(), deliveryCount: 0,
        owners: Object.freeze([...(input.owners ?? [])]),
        ...(input.transportId === undefined ? {} : { transportId: input.transportId }),
      });
      if (!disposed) {
        records.set(id, record);
        const identity = app;
        const sourceIdentity = source;
        releaseSources.set(id, () => {
          if (--sourceIdentity.uses === 0) identity.sources.delete(key);
        });
        notify('start', record);
      }
      function update(phase: SdkActivityEvent['phase'], patch: Partial<SdkActivityRecord>, usage?: UsageEvidence): void {
        const current = records.get(id);
        if (!current || current.endedAt !== undefined) return;
        const next = Object.freeze({ ...current, ...patch });
        records.set(id, next);
        notify(phase, next, usage);
      }
      function end(status: 'completed' | 'failed' | 'closed', usage?: UsageEvidence): void {
        update('end', { status, endedAt: now() }, usage);
        prune();
      }
      return {
        id,
        delivered(snapshot, suppliedUsage) {
          const current = records.get(id);
          if (!current || (current.kind === 'operation' && current.deliveryCount > 0)) return;
          let usage: UsageEvidence;
          try {
            usage = suppliedUsage ?? (current.service === 'firestore'
              ? (current.method.endsWith('FromCache') ? { documentReads: 0 } : firestoreReadUsage(snapshot, current.kind === 'subscription', current.deliveryCount === 0))
              : databaseReadUsage(snapshot));
          } catch { usage = { unmeasured: 1 }; }
          update('delivery', { deliveryCount: current.deliveryCount + 1, lastDeliveryAt: now() }, usage);
        },
        progress() { update('progress', { lastProgressAt: now() }); },
        complete(usage) { end('completed', usage ?? (record.service === 'firestore' ? firestoreWriteUsage(record.method) : undefined)); },
        fail() { end('failed'); },
        close() { end('closed'); },
        transport(transportId) { update('transport', { transportId }); },
      };
    },
    records(): readonly SdkActivityRecord[] {
      prune();
      return [...records.values()];
    },
    subscribe(subscriber: (event: SdkActivityEvent) => void): () => void {
      if (!disposed) subscribers.add(subscriber);
      return () => { subscribers.delete(subscriber); };
    },
    /** Live observations, independent of history retention and Flow rendering. */
    observe(observer: (observation: SdkObservation) => void): () => void {
      if (!disposed) observers.add(observer);
      return () => { observers.delete(observer); };
    },
    dispose(): void {
      disposed = true;
      clearTimeout(timer);
      for (const record of [...records.values()]) remove(record);
      subscribers.clear();
      observers.clear();
    },
  };
}

/** Shared by the in-page SDK, bridge adapters, and the page's runtime chip. */
const JOURNAL_KEY = Symbol.for('pyric.sdk-activity');
const globalStore = globalThis as {
  [JOURNAL_KEY]?: ReturnType<typeof createSdkActivityJournal>;
};
// SDK and runtime bundles may load separate source/dist copies in one realm.
export const sdkActivity = globalStore[JOURNAL_KEY]
  ?? (globalStore[JOURNAL_KEY] = createSdkActivityJournal());

/** Return the same snapshot synchronously, without adding a Promise reaction. */
export function finishSdkRead<T>(activity: SdkActivityHandle, snapshot: T): T {
  activity.delivered(snapshot);
  activity.complete();
  return snapshot;
}
