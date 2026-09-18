import { RulesEvidenceRetention } from './rules-evidence-retention.js';
import type { SandboxEvent, SandboxObservationGapEvent } from '../types/events.js';

export interface EventHistoryLimits {
  maxEvents: number;
  maxBytes: number;
  maxAgeMs?: number;
}

interface HistoryEntry {
  event: SandboxEvent;
  bytes: number;
}

const utf8 = new TextEncoder();

function encodedBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    const hasBuffer = typeof Buffer === 'function';
    return hasBuffer ? Buffer.byteLength(json) : utf8.encode(json).byteLength;
  }
  catch { return Infinity; }
}

/** One observation history owner; adapters may bound retention without truncating undo state. */
export class EventHistory {
  private entries: HistoryEntry[] = [];
  private bytes = 0;
  // Live state outside retained history reserves capacity but is never evicted.
  private liveCount = 0;
  private liveBytes = 0;
  private readonly activeRequests = new Map<string, HistoryEntry>();
  private readonly completedRequests = new Set<string>();
  private readonly activeListeners = new Map<string, HistoryEntry>();
  private readonly retainedIds = new Set<string>();
  private readonly rulesEvidence = new RulesEvidenceRetention<HistoryEntry>();
  private sourceGapCount = 0;
  private gap: SandboxObservationGapEvent | undefined;

  constructor(private readonly limits?: EventHistoryLimits) {}

  get length(): number {
    return this.snapshot().length;
  }

  append(event: SandboxEvent): void {
    const observation = event.kind === 'operation' ? event.observation : undefined;
    const isBounded = this.limits !== undefined;
    const bytes = isBounded ? encodedBytes(event) + 1 : 0;
    if (observation?.status === 'pending') {
      if (this.completedRequests.has(observation.id)) return;
      const previous = this.activeRequests.get(observation.id);
      if (previous) this.releaseLive(previous);
      const entry = { event, bytes };
      this.activeRequests.set(observation.id, entry);
      this.reserveLive(entry);
      this.prune();
      return;
    }
    if (observation) {
      const pending = this.activeRequests.get(observation.id);
      if (pending) this.releaseLive(pending);
      this.activeRequests.delete(observation.id);
      this.completedRequests.add(observation.id);
    }
    this.trackListener(event, bytes);
    if (this.retainedIds.has(event.id)) return;
    this.retainedIds.add(event.id);
    const activeListener = 'listenerId' in event ? this.activeListeners.get(event.listenerId) : undefined;
    const retainsListener = activeListener?.event.id === event.id;
    if (retainsListener) this.releaseLive(activeListener);
    const isPriorEviction = isBounded && event.kind === 'observation_gap' && event.reason === 'history-limit';
    const mustOmit = isPriorEviction || !Number.isFinite(bytes);
    if (mustOmit) {
      this.forgetId(event);
      if (isPriorEviction) {
        const omittedCount = Math.max(0, event.omittedCount - this.sourceGapCount);
        this.sourceGapCount = Math.max(this.sourceGapCount, event.omittedCount);
        if (omittedCount) this.omit({ ...event, omittedCount });
      } else this.omit(event);
    } else {
      const entry = { event, bytes };
      this.entries.push(entry);
      this.bytes += bytes;
      const expired = this.rulesEvidence.record(entry);
      const hasExpiredEvidence = expired !== undefined;
      if (hasExpiredEvidence) this.expireRulesEvidence(expired);
    }
    this.prune();
  }

  snapshot(): SandboxEvent[] {
    this.pruneExpired();
    const events = [...this.entries.map(entry => entry.event), ...[...this.activeRequests.values()].map(entry => entry.event),
      ...[...this.activeListeners.values()].map(entry => entry.event).filter(event => !this.retainedIds.has(event.id))];
    const gap = this.gap;
    const hasGap = gap !== undefined;
    return hasGap ? [{ ...gap }, ...events] : events;
  }

  clear(): void {
    this.entries = [];
    this.activeRequests.clear();
    this.activeListeners.clear();
    this.completedRequests.clear();
    this.retainedIds.clear();
    this.rulesEvidence.clear();
    this.bytes = 0;
    this.liveCount = 0;
    this.liveBytes = 0;
    this.gap = undefined;
    this.sourceGapCount = 0;
  }

  private forgetId(event: SandboxEvent): void {
    this.retainedIds.delete(event.id);
    const listener = 'listenerId' in event ? this.activeListeners.get(event.listenerId) : undefined;
    const isActiveListener = listener?.event.id === event.id;
    if (isActiveListener) this.reserveLive(listener);
    const observation = event.kind === 'operation' ? event.observation : undefined;
    if (observation) this.completedRequests.delete(observation.id);
  }

  private trackListener(event: SandboxEvent, bytes: number): void {
    if (!('listenerId' in event)) return;
    const attaches = event.kind === 'listener_attach' || (event.kind === 'listener' && event.phase === 'attach');
    const closes = event.kind === 'listener_detach' || event.kind === 'listener_errored'
      || (event.kind === 'listener' && (event.phase === 'detach' || event.phase === 'errored'));
    const changesRegistration = attaches || closes;
    if (!changesRegistration) return;
    const previous = this.activeListeners.get(event.listenerId);
    const previousIsLiveOnly = previous !== undefined && !this.retainedIds.has(previous.event.id);
    if (previousIsLiveOnly) this.releaseLive(previous);
    if (attaches) {
      const entry = { event, bytes };
      this.activeListeners.set(event.listenerId, entry);
      const isLiveOnly = !this.retainedIds.has(event.id);
      if (isLiveOnly) this.reserveLive(entry);
    } else this.activeListeners.delete(event.listenerId);
  }

  private pruneExpired(): void {
    const maxAge = this.limits?.maxAgeMs;
    if (maxAge === undefined) return;
    const cutoff = Date.now() - maxAge;
    const oldestIsExpired = () => {
      const event = this.entries[0]?.event;
      return event !== undefined && (event.observedAt ?? event.at) < cutoff;
    };
    while (oldestIsExpired()) {
      const oldest = this.entries.shift()!;
      this.forgetId(oldest.event);
      this.rulesEvidence.forget(oldest);
      this.bytes -= oldest.bytes;
      this.omit(oldest.event);
    }
  }

  private expireRulesEvidence(entry: HistoryEntry): void {
    const event = entry.event;
    const isOtherEvent = event.kind !== 'request';
    if (isOtherEvent) return;
    const { rulesEvidence, ...metadata } = event;
    entry.event = { ...metadata, rulesEvidenceExpired: true };
    const isBounded = this.limits !== undefined;
    const bytes = isBounded ? encodedBytes(entry.event) + 1 : 0;
    this.bytes += bytes - entry.bytes;
    entry.bytes = bytes;
  }

  private reserveLive(entry: HistoryEntry): void {
    this.liveCount++;
    this.liveBytes += entry.bytes;
  }

  private releaseLive(entry: HistoryEntry): void {
    this.liveCount--;
    this.liveBytes -= entry.bytes;
  }

  private prune(): void {
    this.pruneExpired();
    let exceedsLimits = this.exceedsLimits();
    while (exceedsLimits) {
      const oldest = this.entries.shift();
      const isEmpty = oldest === undefined;
      if (isEmpty) break;
      this.forgetId(oldest.event);
      this.rulesEvidence.forget(oldest);
      this.bytes -= oldest.bytes;
      this.omit(oldest.event);
      exceedsLimits = this.exceedsLimits();
    }
  }

  private exceedsLimits(): boolean {
    const limits = this.limits;
    const isUnbounded = limits === undefined;
    if (isUnbounded) return false;
    const hasNoGap = this.gap === undefined;
    const gapBytes = hasNoGap ? 0 : encodedBytes(this.gap) + 1;
    const eventCount = this.entries.length + this.liveCount;
    const exceedsCount = eventCount > limits.maxEvents;
    const exceedsBytes = this.bytes + this.liveBytes + gapBytes + 2 > limits.maxBytes;
    return exceedsCount || exceedsBytes;
  }

  private omit(event: SandboxEvent): void {
    const isGap = event.kind === 'observation_gap';
    const count = isGap ? event.omittedCount : 1;
    const first = isGap ? event.firstEventId : event.id;
    const last = isGap ? event.lastEventId : event.id;
    this.gap = {
      kind: 'observation_gap', reason: 'history-limit', id: 'history-gap',
      at: this.gap?.at ?? event.at,
      firstEventId: this.gap?.firstEventId ?? first, lastEventId: last,
      omittedCount: (this.gap?.omittedCount ?? 0) + count,
    };
  }
}
