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
  readonly commitId?: number;
  readonly deliverySequences?: readonly number[];
}

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

export function createActivityHistory(options: { now?: () => number; limit?: number } = {}) {
  const now = options.now ?? Date.now;
  const limit = Math.max(1, options.limit ?? 100);
  let entries: ActivityHistoryEntry[] = [];
  let discarded = 0;
  let sequence = 0;
  let since = now();
  function append(record: SdkActivityRecord, phase: ActivityHistoryPhase, commitId?: number, deliverySequences?: readonly number[]) {
    const entry = Object.freeze({
      sequence: ++sequence, at: now(), phase,
      activityId: record.id, sourceId: record.sourceId, appId: record.appId,
      service: record.service, target: activityDisplayTarget(record.target),
      method: record.method, kind: record.kind, status: record.status,
      ...(commitId === undefined ? {} : { commitId }),
      ...(deliverySequences === undefined ? {} : { deliverySequences: Object.freeze([...deliverySequences]) }),
    });
    entries.push(entry);
    if (entries.length > limit) { entries.shift(); discarded++; }
    return entry;
  }
  return {
    record(event: SdkActivityEvent) {
      if (event.phase === 'start' || event.phase === 'delivery' || event.phase === 'end') append(event.record, event.phase);
    },
    rendered(record: SdkActivityRecord, commitId: number, windowMs = 250) {
      const existing = entries.find(entry => entry.activityId === record.id && entry.commitId === commitId);
      if (existing) return existing;
      const associated = new Set(entries.flatMap(entry => entry.deliverySequences ?? []));
      const deliveries = entries.filter(entry => entry.activityId === record.id && entry.phase === 'delivery'
        && entry.at > now() - windowMs && !associated.has(entry.sequence)).map(entry => entry.sequence);
      return append(record, 'render', commitId, deliveries);
    },
    association(sequence: number) {
      const selected = entries.find(entry => entry.sequence === sequence);
      if (!selected) return undefined;
      if (selected.phase === 'render') return selected;
      if (selected.phase === 'delivery') return entries.find(entry => entry.deliverySequences?.includes(sequence));
      // Start/outcome entries describe the invocation as a whole.
      return entries.find(entry => entry.activityId === selected.activityId && entry.phase === 'render');
    },
    snapshot() { return { entries: [...entries], discarded, since, limit }; },
    counts(sourceId?: string) {
      const recent = entries.filter(entry => entry.at > now() - 30_000 && (!sourceId || entry.sourceId === sourceId));
      return {
        calls: recent.filter(entry => entry.phase === 'start').length,
        deliveries: recent.filter(entry => entry.phase === 'delivery').length,
        commits: new Set(recent.filter(entry => entry.phase === 'render').map(entry => entry.commitId)).size,
        partial: discarded > 0,
      };
    },
    clear() { entries = []; discarded = 0; since = now(); },
  };
}
export type ActivityHistory = ReturnType<typeof createActivityHistory>;
