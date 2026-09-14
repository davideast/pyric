import type { ListenerOwner } from '../types/events.js';

/** Page-side SDK evidence. Transport messages are deliberately not deliveries. */
export interface SdkActivitySource {
  readonly service: 'firestore' | 'database';
  readonly target: string;
  /** Canonical adapter descriptor, used only for identity, never exposed in records. */
  readonly key: string;
  readonly isQuery?: boolean;
}

export interface SdkActivityRecord {
  readonly id: string;
  readonly appId: string;
  readonly sourceId: string;
  readonly service: SdkActivitySource['service'];
  readonly target: string;
  readonly isQuery: boolean;
  readonly method: string;
  readonly kind: 'operation' | 'subscription';
  readonly status: 'pending' | 'active' | 'completed' | 'failed' | 'closed';
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly deliveryCount: number;
  readonly lastDeliveryAt?: number;
  readonly owners: readonly ListenerOwner[];
  /** Optional bridge identity. It is not the logical activity id. */
  readonly transportId?: string;
}

export interface SdkActivityHandle {
  readonly id: string;
  /** Call immediately before handing a successful result to application code. */
  delivered(): void;
  complete(): void;
  fail(): void;
  close(): void;
  transport(id: string): void;
}

export interface SdkActivityEvent {
  readonly phase: 'start' | 'delivery' | 'end' | 'remove' | 'transport';
  readonly record: SdkActivityRecord;
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
  retentionMs?: number;
  maxCompleted?: number;
  /** Protect completed deliveries until the page's render window has elapsed. */
  correlationWindowMs?: number;
} = {}) {
  const now = options.now ?? Date.now;
  const correlationWindowMs = options.correlationWindowMs ?? 250;
  const retentionMs = Math.max(options.retentionMs ?? 30_000, correlationWindowMs);
  const maxCompleted = options.maxCompleted ?? 100;
  const apps = new WeakMap<object, AppIdentity>();
  const records = new Map<string, SdkActivityRecord>();
  const releaseSources = new Map<string, () => void>();
  const subscribers = new Set<(event: SdkActivityEvent) => void>();
  let appSerial = 0;
  let sourceSerial = 0;
  let activitySerial = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let registrationId: string | undefined;
  let silenced = false;
  let pruning = false;

  function notify(phase: SdkActivityEvent['phase'], record: SdkActivityRecord): void {
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
        id: '', delivered() {}, complete() {}, fail() {}, close() {}, transport() {},
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
      function update(phase: SdkActivityEvent['phase'], patch: Partial<SdkActivityRecord>): void {
        const current = records.get(id);
        if (!current || current.endedAt !== undefined) return;
        const next = Object.freeze({ ...current, ...patch });
        records.set(id, next);
        notify(phase, next);
      }
      function end(status: 'completed' | 'failed' | 'closed'): void {
        update('end', { status, endedAt: now() });
        prune();
      }
      return {
        id,
        delivered() {
          const current = records.get(id);
          if (!current || (current.kind === 'operation' && current.deliveryCount > 0)) return;
          update('delivery', { deliveryCount: current.deliveryCount + 1, lastDeliveryAt: now() });
        },
        complete() { end('completed'); },
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
    dispose(): void {
      disposed = true;
      clearTimeout(timer);
      for (const record of [...records.values()]) remove(record);
      subscribers.clear();
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
  activity.delivered();
  activity.complete();
  return snapshot;
}
