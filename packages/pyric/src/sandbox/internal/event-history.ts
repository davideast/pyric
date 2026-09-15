import { RulesEvidenceRetention } from './rules-evidence-retention.js';
import type { SandboxEvent, SandboxObservationGapEvent } from '../types/events.js';

export interface EventHistoryLimits {
  maxEvents: number;
  maxBytes: number;
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
  private entries: Array<{ event: SandboxEvent; bytes: number }> = [];
  private bytes = 0;
  private readonly rulesEvidence = new RulesEvidenceRetention<{ event: SandboxEvent; bytes: number }>();
  private gap: SandboxObservationGapEvent | undefined;

  constructor(private readonly limits?: EventHistoryLimits) {}

  get length(): number {
    const hasGap = this.gap !== undefined;
    return this.entries.length + (hasGap ? 1 : 0);
  }

  append(event: SandboxEvent): void {
    const isBounded = this.limits !== undefined;
    const isPriorEviction = isBounded && event.kind === 'observation_gap' && event.reason === 'history-limit';
    const bytes = isBounded ? encodedBytes(event) + 1 : 0;
    const mustOmit = isPriorEviction || !Number.isFinite(bytes);
    if (mustOmit) {
      this.omit(event);
    } else {
      const entry = { event, bytes };
      this.entries.push(entry);
      this.bytes += bytes;
      const expired = this.rulesEvidence.record(entry);
      const hasExpiredEvidence = expired !== undefined;
      if (hasExpiredEvidence) this.expireRulesEvidence(expired);
    }
    let exceedsLimits = this.exceedsLimits();
    while (exceedsLimits) {
      const oldest = this.entries.shift();
      const isEmpty = oldest === undefined;
      if (isEmpty) break;
      this.rulesEvidence.forget(oldest);
      this.bytes -= oldest.bytes;
      this.omit(oldest.event);
      exceedsLimits = this.exceedsLimits();
    }
  }

  snapshot(): SandboxEvent[] {
    const events = this.entries.map(entry => entry.event);
    const gap = this.gap;
    const hasGap = gap !== undefined;
    return hasGap ? [{ ...gap }, ...events] : events;
  }

  clear(): void {
    this.entries = [];
    this.rulesEvidence.clear();
    this.bytes = 0;
    this.gap = undefined;
  }

  private expireRulesEvidence(entry: { event: SandboxEvent; bytes: number }): void {
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

  private exceedsLimits(): boolean {
    const limits = this.limits;
    const isUnbounded = limits === undefined;
    if (isUnbounded) return false;
    const hasNoGap = this.gap === undefined;
    const gapBytes = hasNoGap ? 0 : encodedBytes(this.gap) + 1;
    const exceedsCount = this.entries.length > limits.maxEvents;
    const exceedsBytes = this.bytes + gapBytes + 2 > limits.maxBytes;
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
