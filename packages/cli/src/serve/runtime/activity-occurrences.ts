import type { ActivityHistoryEntry } from './activity-history.js';

export type RenderEvidence = 'observed' | 'not-observed' | 'unavailable';
interface OccurrenceEvidence {
  readonly event: ActivityHistoryEntry;
  readonly lifecycle: ActivityHistoryEntry['status'];
  readonly render: RenderEvidence;
}
export type ActivityOccurrence = OccurrenceEvidence & (
  | { readonly kind: 'operation'; readonly registration: null }
  | { readonly kind: 'subscription-delivery' | 'subscription-state' | 'subscription-failure'; readonly registration: number | null }
);

interface Invocation {
  latest: ActivityHistoryEntry;
  readonly deliveries: ActivityHistoryEntry[];
  readonly renderedSequences: Set<number>;
}

function summarize(entries: readonly ActivityHistoryEntry[]): Invocation[] {
  const invocations = new Map<string, Invocation>();
  for (const entry of entries) {
    let invocation = invocations.get(entry.activityId);
    if (!invocation) {
      invocation = { latest: entry, deliveries: [], renderedSequences: new Set() };
      invocations.set(entry.activityId, invocation);
    }
    if (entry.sequence > invocation.latest.sequence) invocation.latest = entry;
    if (entry.phase === 'delivery' || entry.phase === 'progress') invocation.deliveries.push(entry);
    for (const sequence of entry.deliverySequences ?? []) invocation.renderedSequences.add(sequence);
  }
  return [...invocations.values()];
}

function evidence(event: ActivityHistoryEntry, invocation: Invocation): OccurrenceEvidence {
  if (event.phase === 'render' || invocation.renderedSequences.has(event.sequence)) {
    return { event, lifecycle: invocation.latest.status, render: 'observed' };
  }
  return {
    event,
    lifecycle: invocation.latest.status,
    render: event.phase === 'delivery' || event.phase === 'progress' ? 'not-observed' : 'unavailable',
  };
}

function operation(invocation: Invocation): ActivityOccurrence {
  // Sequence, rather than caller array order, determines the first result.
  let firstDelivery: ActivityHistoryEntry | undefined;
  for (const entry of invocation.deliveries) {
    if (!firstDelivery || (firstDelivery.phase === 'progress' && entry.phase === 'delivery') || (entry.phase === firstDelivery.phase && entry.sequence < firstDelivery.sequence)) firstDelivery = entry;
  }
  return { ...evidence(firstDelivery ?? invocation.latest, invocation), kind: 'operation', registration: null };
}

function subscription(invocation: Invocation): ActivityOccurrence[] {
  const { latest, deliveries } = invocation;
  // Missing registration evidence stays unknown; never invent subscription #1.
  const registration = latest.subscriptionNumber ?? null;
  if (!deliveries.length) {
    const retained = evidence(latest, invocation);
    if (latest.status === 'failed') {
      return [{ ...retained, kind: 'subscription-failure', registration }];
    }
    if (latest.phase === 'render') {
      return [{ ...retained, kind: 'subscription-delivery', registration }];
    }
    return [{ ...retained, kind: 'subscription-state', registration }];
  }
  const results: ActivityOccurrence[] = deliveries.map(event => ({
    ...evidence(event, invocation), kind: 'subscription-delivery', registration,
  }));
  if (latest.status === 'failed') {
    results.push({ ...evidence(latest, invocation), kind: 'subscription-failure', registration });
  }
  return results;
}

/** Interpret retained evidence; neither complete lifecycles nor input ordering are required. */
export function activityOccurrences(entries: readonly ActivityHistoryEntry[]): ActivityOccurrence[] {
  return summarize(entries)
    .flatMap(invocation => invocation.latest.kind === 'operation' ? [operation(invocation)] : subscription(invocation))
    .sort((a, b) => b.event.at - a.event.at || b.event.sequence - a.event.sequence);
}
