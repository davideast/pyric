import { encodedBytes } from './history-retention.js';
import {
  EventHistoryLanes,
  isDenialOrErrorEvent,
  resolveDenialLaneLimits,
  type DenialLaneLimits,
  type EventHistoryLimits,
  type HistoryEntry,
} from './history-lanes.js';
export type { EventHistoryLimits } from './history-lanes.js';
import { RulesEvidenceRetention } from './rules-evidence-retention.js';
import type { SandboxEvent, SandboxObservationGapEvent } from '../types/events.js';

interface LiveEntry {
  event: SandboxEvent;
  bytes: number;
}

/** One observation history owner; adapters may bound retention without truncating undo state. */
export class EventHistory {
  private readonly lanes = new EventHistoryLanes();
  private readonly denialLimits: DenialLaneLimits | undefined;
  // Live state remains visible; its reservation may use at most half the history budget.
  private liveCount = 0;
  private liveBytes = 0;
  private readonly activeRequests = new Map<string, LiveEntry>();
  private readonly completedRequests = new Set<string>();
  private readonly activeListeners = new Map<string, LiveEntry>();
  private readonly retainedIds = new Set<string>();
  private readonly rulesEvidence = new RulesEvidenceRetention<HistoryEntry>();
  private sourceGapCount = 0;
  private sourceGapDenialCount = 0;
  private gap: SandboxObservationGapEvent | undefined;

  constructor(private readonly limits?: EventHistoryLimits) {
    this.denialLimits = resolveDenialLaneLimits(limits);
  }

  get length(): number {
    return this.snapshot().length;
  }

  append(event: SandboxEvent): void {
    let observation: Extract<SandboxEvent, { kind: 'operation' }>['observation'];
    if (event.kind === 'operation') observation = event.observation;
    const isBounded = this.limits !== undefined;
    let bytes = 0;
    if (isBounded) bytes = encodedBytes(event) + 1;
    if (observation?.status === 'pending') {
      if (this.completedRequests.has(observation.id)) return;
      const previous = this.activeRequests.get(observation.id);
      if (previous !== undefined) this.releaseLive(previous);
      const entry: LiveEntry = { event, bytes };
      this.activeRequests.set(observation.id, entry);
      this.reserveLive(entry);
      this.prune();
      return;
    }
    if (observation !== undefined) {
      const pending = this.activeRequests.get(observation.id);
      if (pending !== undefined) this.releaseLive(pending);
      this.activeRequests.delete(observation.id);
      this.completedRequests.add(observation.id);
    }
    this.trackListener(event, bytes);
    if (this.retainedIds.has(event.id)) return;
    this.retainedIds.add(event.id);
    const activeListener = this.lookupActiveListener(event);
    const retainsListener = activeListener?.event.id === event.id;
    if (retainsListener && activeListener !== undefined) this.releaseLive(activeListener);
    const isPriorEviction = isBounded && event.kind === 'observation_gap' && event.reason === 'history-limit';
    const mustOmit = isPriorEviction || !Number.isFinite(bytes);
    if (mustOmit) {
      this.forgetId(event);
      if (isPriorEviction) {
        const omittedCount = Math.max(0, event.omittedCount - this.sourceGapCount);
        this.sourceGapCount = Math.max(this.sourceGapCount, event.omittedCount);
        const priorDenials = event.omittedDenials ?? 0;
        const omittedDenials = Math.max(0, priorDenials - this.sourceGapDenialCount);
        this.sourceGapDenialCount = Math.max(this.sourceGapDenialCount, priorDenials);
        if (omittedCount > 0 || omittedDenials > 0) {
          this.omit({ ...event, omittedCount, omittedDenials });
        }
      } else {
        this.omit(event);
      }
    } else {
      const entry = this.lanes.push(event, bytes);
      const expired = this.rulesEvidence.record(entry);
      if (expired !== undefined) this.expireRulesEvidence(expired);
    }
    this.prune();
  }

  snapshot(): SandboxEvent[] {
    const events = this.lanes.snapshotEvents();
    for (const entry of this.activeRequests.values()) events.push(entry.event);
    for (const entry of this.activeListeners.values()) {
      if (!this.retainedIds.has(entry.event.id)) events.push(entry.event);
    }
    if (this.gap === undefined) return events;
    return [{ ...this.gap }, ...events];
  }

  clear(): void {
    this.lanes.clear();
    this.activeRequests.clear();
    this.activeListeners.clear();
    this.completedRequests.clear();
    this.retainedIds.clear();
    this.rulesEvidence.clear();
    this.liveCount = 0;
    this.liveBytes = 0;
    this.gap = undefined;
    this.sourceGapCount = 0;
    this.sourceGapDenialCount = 0;
  }

  private lookupActiveListener(event: SandboxEvent): LiveEntry | undefined {
    if (!('listenerId' in event)) return undefined;
    return this.activeListeners.get(event.listenerId);
  }

  private forgetId(event: SandboxEvent): void {
    this.retainedIds.delete(event.id);
    const listener = this.lookupActiveListener(event);
    const isActiveListener = listener?.event.id === event.id;
    if (isActiveListener && listener !== undefined) this.reserveLive(listener);
    if (event.kind === 'operation' && event.observation !== undefined) {
      this.completedRequests.delete(event.observation.id);
    }
  }

  private trackListener(event: SandboxEvent, bytes: number): void {
    if (!('listenerId' in event)) return;
    const attaches = event.kind === 'listener_attach' || (event.kind === 'listener' && event.phase === 'attach');
    const closes = event.kind === 'listener_detach' || event.kind === 'listener_errored'
      || (event.kind === 'listener' && (event.phase === 'detach' || event.phase === 'errored'));
    if (!attaches && !closes) return;
    const previous = this.activeListeners.get(event.listenerId);
    const previousIsLiveOnly = previous !== undefined && !this.retainedIds.has(previous.event.id);
    if (previousIsLiveOnly && previous !== undefined) this.releaseLive(previous);
    if (attaches) {
      const entry: LiveEntry = { event, bytes };
      this.activeListeners.set(event.listenerId, entry);
      if (!this.retainedIds.has(event.id)) this.reserveLive(entry);
    } else {
      this.activeListeners.delete(event.listenerId);
    }
    if (previousIsLiveOnly && previous !== undefined) this.omit(previous.event);
  }

  private expireRulesEvidence(entry: HistoryEntry): void {
    const event = entry.event;
    if (event.kind !== 'request') return;
    const { rulesEvidence: _rulesEvidence, ...metadata } = event;
    entry.event = { ...metadata, rulesEvidenceExpired: true };
    let bytes = 0;
    if (this.limits !== undefined) bytes = encodedBytes(entry.event) + 1;
    this.lanes.updateBytes(entry, bytes);
  }

  private reserveLive(entry: LiveEntry): void {
    this.liveCount += 1;
    this.liveBytes += entry.bytes;
  }

  private releaseLive(entry: LiveEntry): void {
    this.liveCount -= 1;
    this.liveBytes -= entry.bytes;
  }

  private prune(): void {
    while (this.exceedsDenialLimits()) {
      const oldest = this.lanes.shiftDenial();
      if (oldest === undefined) break;
      this.evictEntry(oldest);
    }
    while (this.exceedsLimits()) {
      const oldest = this.lanes.shiftForTotalBudget();
      if (oldest === undefined) break;
      this.evictEntry(oldest);
    }
  }

  private evictEntry(entry: HistoryEntry): void {
    this.forgetId(entry.event);
    this.rulesEvidence.forget(entry);
    this.omit(entry.event);
  }

  private exceedsDenialLimits(): boolean {
    const denialLimits = this.denialLimits;
    if (denialLimits === undefined) return false;
    return this.lanes.denialCount > denialLimits.maxEvents
      || this.lanes.denialBytes > denialLimits.maxBytes;
  }

  private exceedsLimits(): boolean {
    const limits = this.limits;
    if (limits === undefined) return false;
    let gapBytes = 0;
    if (this.gap !== undefined) gapBytes = encodedBytes(this.gap) + 1;
    const reservedEvents = Math.min(this.liveCount, Math.floor(limits.maxEvents / 2));
    const reservedBytes = Math.min(this.liveBytes, Math.floor(limits.maxBytes / 2));
    const eventCount = this.lanes.totalCount + reservedEvents;
    const exceedsCount = eventCount > limits.maxEvents;
    const exceedsBytes = this.lanes.totalBytes + reservedBytes + gapBytes + 2 > limits.maxBytes;
    return exceedsCount || exceedsBytes;
  }

  private omit(event: SandboxEvent): void {
    const listener = this.lookupActiveListener(event);
    const remainsVisible = listener?.event.id === event.id;
    if (remainsVisible) return;
    let count = 1;
    let denialCount = 0;
    let first = event.id;
    let last = event.id;
    if (event.kind === 'observation_gap') {
      count = event.omittedCount;
      denialCount = event.omittedDenials ?? 0;
      first = event.firstEventId;
      last = event.lastEventId;
    } else if (isDenialOrErrorEvent(event)) {
      denialCount = 1;
    }
    this.gap = {
      kind: 'observation_gap',
      reason: 'history-limit',
      id: 'history-gap',
      at: this.gap?.at ?? event.at,
      firstEventId: this.gap?.firstEventId ?? first,
      lastEventId: last,
      omittedCount: (this.gap?.omittedCount ?? 0) + count,
      omittedDenials: (this.gap?.omittedDenials ?? 0) + denialCount,
    };
  }
}
