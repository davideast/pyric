import type { SdkActivityEvent, SdkActivityRecord } from 'pyric/sandbox/internal';

export type ActivityHistoryPhase = 'start' | 'delivery' | 'end' | 'render';
export interface ActivityHistoryEntry {
  readonly sequence: number;
  readonly at: number;
  readonly phase: ActivityHistoryPhase;
  readonly activityId: string;
  readonly sourceId: string;
  readonly appId: string;
  readonly service: SdkActivityRecord['service'];
  readonly target: string;
  readonly method: string;
  readonly kind: SdkActivityRecord['kind'];
  readonly status: SdkActivityRecord['status'];
  readonly indexQuery?: SdkActivityRecord['indexQuery'];
  readonly subscriptionNumber?: number;
  readonly commitId?: number;
  readonly deliverySequences?: readonly number[];
}

export interface ActivityHistoryOptions {
  readonly now?: () => number;
  readonly limit?: number;
}
export interface ActivityCounts {
  readonly calls: number;
  readonly deliveries: number;
  readonly commits: number;
  readonly partial: boolean;
}
export interface ActivityHistorySnapshot {
  readonly entries: readonly ActivityHistoryEntry[];
  readonly discarded: number;
  readonly since: number;
  readonly limit: number;
}
export type ActivityCountScope = { readonly kind: 'retained' } | { readonly kind: 'recent'; readonly windowMs: number };
export interface ActivityHistory {
  record(event: SdkActivityEvent): void;
  rendered(record: SdkActivityRecord, commitId: number, windowMs?: number): ActivityHistoryEntry;
  association(sequence: number): ActivityHistoryEntry | undefined;
  snapshot(): ActivityHistorySnapshot;
  counts(options?: { readonly sourceId?: string; readonly scope?: ActivityCountScope }): ActivityCounts;
  /** Clear retained evidence while preserving numbers for active subscriptions. */
  clear(): void;
  dispose(): void;
}
type AppendInput = { readonly record: SdkActivityRecord } & (
  | { readonly phase: 'start' | 'delivery' | 'end' }
  | { readonly phase: 'render'; readonly commitId: number; readonly deliverySequences: readonly number[] }
);

/** Only display metadata crosses into history: never SDK values or owner objects. */
export function activityDisplayTarget(target: string): string {
  // SDK targets are paths; tolerate URLs without exposing credentials or queries.
  try {
    const url = new URL(target);
    return `${url.protocol}//${url.host}${url.pathname}`.slice(0, 512);
  } catch {
    return target.split(/[?#]/, 1)[0].replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 512);
  }
}

export function createActivityHistory(options: ActivityHistoryOptions = {}): ActivityHistory {
  const now = options.now ?? Date.now;
  const limit = Math.max(1, options.limit ?? 100);
  let entries: ActivityHistoryEntry[] = [];
  let discarded = 0;
  let sequence = 0;
  let since = now();
  let subscriptionSerial = 0;
  const subscriptionNumbers = new Map<string, number>();
  const active = new Set<string>();
  const pruneNumbers = () => {
    const retained = new Set(entries.map(entry => entry.activityId));
    for (const id of subscriptionNumbers.keys()) {
      if (!active.has(id) && !retained.has(id)) subscriptionNumbers.delete(id);
    }
  };
  function append(input: AppendInput): ActivityHistoryEntry {
    const { record, phase } = input;
    if (record.kind === 'subscription' && !subscriptionNumbers.has(record.id)) {
      subscriptionNumbers.set(record.id, ++subscriptionSerial);
    }
    const entry = Object.freeze({
      sequence: ++sequence,
      at: now(),
      phase,
      activityId: record.id,
      sourceId: record.sourceId,
      appId: record.appId,
      service: record.service,
      target: activityDisplayTarget(record.target),
      method: record.method,
      kind: record.kind,
      status: record.status,
      ...(record.indexQuery ? { indexQuery: record.indexQuery } : {}),
      subscriptionNumber: subscriptionNumbers.get(record.id),
      ...(input.phase === 'render' ? { commitId: input.commitId, deliverySequences: Object.freeze([...input.deliverySequences]) } : {}),
    });
    entries.push(entry);
    if (entries.length > limit) {
      entries.shift();
      discarded++;
    }
    pruneNumbers();
    return entry;
  }
  return {
    record(event: SdkActivityEvent) {
      const { record, phase } = event;
      if (record.kind === 'subscription' && record.status === 'active') {
        active.add(record.id);
      }
      if (phase === 'end' || phase === 'remove') {
        active.delete(record.id);
      }
      switch (phase) {
        case 'start':
        case 'delivery':
        case 'end':
          append({ record, phase });
          return;
        case 'remove':
        case 'transport':
          pruneNumbers();
          return;
      }
    },
    rendered(record: SdkActivityRecord, commitId: number, windowMs = 250) {
      const existing = entries.find(entry => entry.activityId === record.id && entry.commitId === commitId);
      if (existing) return existing;
      const associated = new Set(entries.flatMap(entry => entry.deliverySequences ?? []));
      const cutoff = now() - windowMs;
      const deliveries = entries
        .filter(entry => entry.activityId === record.id
          && entry.phase === 'delivery'
          && entry.at > cutoff
          && !associated.has(entry.sequence))
        .map(entry => entry.sequence);
      return append({ record, phase: 'render', commitId, deliverySequences: deliveries });
    },
    association(sequence: number) {
      const selected = entries.find(entry => entry.sequence === sequence);
      if (!selected) return undefined;
      if (selected.phase === 'render') return selected;
      if (selected.phase === 'delivery') return entries.find(entry => entry.deliverySequences?.includes(sequence));
      // Start/outcome entries describe the invocation as a whole.
      return entries.find(entry => entry.activityId === selected.activityId && entry.phase === 'render');
    },
    snapshot() {
      return { entries: [...entries], discarded, since, limit };
    },
    counts({ sourceId, scope = { kind: 'recent', windowMs: 30_000 } } = {}) {
      const cutoff = scope.kind === 'recent' ? now() - scope.windowMs : null;
      let calls = 0;
      let deliveries = 0;
      const commits = new Set<number>();
      for (const entry of entries) {
        if (cutoff !== null && entry.at <= cutoff) continue;
        if (sourceId !== undefined && entry.sourceId !== sourceId) continue;
        switch (entry.phase) {
          case 'start': calls++; break;
          case 'delivery': deliveries++; break;
          case 'render':
            if (entry.commitId !== undefined) commits.add(entry.commitId);
            break;
          case 'end': break;
        }
      }
      return { calls, deliveries, commits: commits.size, partial: discarded > 0 };
    },
    clear() {
      entries = [];
      discarded = 0;
      since = now();
      pruneNumbers();
    },
    dispose() {
      entries = [];
      active.clear();
      subscriptionNumbers.clear();
    },
  };
}
