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
  readonly subscriptionNumber?: number;
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
  let subscriptionSerial = 0;
  const subscriptionNumbers = new Map<string, number>();
  const active = new Set<string>();
  const pruneNumbers = () => {
    const retained = new Set(entries.map(entry => entry.activityId));
    for (const id of subscriptionNumbers.keys()) if (!active.has(id) && !retained.has(id)) subscriptionNumbers.delete(id);
  };
  function append(record: SdkActivityRecord, phase: ActivityHistoryPhase, commitId?: number, deliverySequences?: readonly number[]) {
    if (record.kind === 'subscription' && !subscriptionNumbers.has(record.id)) subscriptionNumbers.set(record.id, ++subscriptionSerial);
    const entry = Object.freeze({
      sequence: ++sequence, at: now(), phase,
      activityId: record.id, sourceId: record.sourceId, appId: record.appId,
      service: record.service, target: activityDisplayTarget(record.target),
      method: record.method, kind: record.kind, status: record.status,
      subscriptionNumber: subscriptionNumbers.get(record.id),
      ...(commitId === undefined ? {} : { commitId }),
      ...(deliverySequences === undefined ? {} : { deliverySequences: Object.freeze([...deliverySequences]) }),
    });
    entries.push(entry);
    if (entries.length > limit) { entries.shift(); discarded++; }
    pruneNumbers();
    return entry;
  }
  return {
    record(event: SdkActivityEvent) {
      if (event.record.kind === 'subscription' && event.record.status === 'active') active.add(event.record.id);
      if (event.phase === 'end' || event.phase === 'remove') active.delete(event.record.id);
      if (event.phase === 'start' || event.phase === 'delivery' || event.phase === 'end') append(event.record, event.phase);
      pruneNumbers();
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
    counts(sourceId?: string, windowMs = 30_000) {
      const recent = entries.filter(entry => entry.at > now() - windowMs && (!sourceId || entry.sourceId === sourceId));
      return {
        calls: recent.filter(entry => entry.phase === 'start').length,
        deliveries: recent.filter(entry => entry.phase === 'delivery').length,
        commits: new Set(recent.filter(entry => entry.phase === 'render').map(entry => entry.commitId)).size,
        partial: discarded > 0,
      };
    },
    clear() { entries = []; discarded = 0; since = now(); pruneNumbers(); },
    dispose() { entries = []; active.clear(); subscriptionNumbers.clear(); },
  };
}
export type ActivityHistory = ReturnType<typeof createActivityHistory>;

/** A user-visible occurrence combines lifecycle evidence instead of listing its stages. */
export function activityOccurrences(entries: readonly ActivityHistoryEntry[]) {
  const invocations = new Map<string, ActivityHistoryEntry[]>();
  for (const entry of entries) {
    const group = invocations.get(entry.activityId) ?? [];
    group.push(entry);
    invocations.set(entry.activityId, group);
  }
  return [...invocations.values()].flatMap(events => {
    const latest = events.at(-1)!;
    const deliveries = events.filter(event => event.phase === 'delivery');
    const registration = latest.kind === 'subscription' ? latest.subscriptionNumber ?? 1 : null;
    let occurrences = deliveries;
    if (latest.kind === 'operation') occurrences = [deliveries[0] ?? latest];
    else if (!deliveries.length) occurrences = [latest];
    else if (latest.status === 'failed') occurrences = [...deliveries, latest];
    return occurrences.map(event => {
      const rendered = event.phase === 'render' || events.some(candidate => candidate.deliverySequences?.includes(event.sequence));
      let outcome = 'No render observed';
      if (rendered) outcome = 'Rendered';
      if (event.phase !== 'delivery' && latest.status === 'failed') outcome = 'Failed';
      if (latest.kind === 'operation' && latest.status === 'failed') outcome = 'Failed';
      if (latest.status === 'pending') outcome = 'Pending';
      if (!deliveries.length && !rendered && latest.status === 'active') outcome = 'Listening';
      if (!deliveries.length && !rendered && latest.status === 'closed') outcome = 'Stopped';
      let label = 'Read result';
      if (event.method === 'getDoc') label = 'Read document';
      if (event.method === 'getDocs') label = 'Read collection';
      if (event.method === 'get') label = 'Read database';
      if (registration !== null) label = 'Update received';
      if (registration !== null && !deliveries.length && event.phase !== 'render') label = 'Subscription';
      if (outcome === 'Failed') label = 'Request failed';
      return { event, label, outcome, registration };
    });
  }).sort((a, b) => b.event.at - a.event.at || b.event.sequence - a.event.sequence);
}
