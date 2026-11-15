import type { EventHistoryLimits as BaseEventHistoryLimits } from './history-retention.js';
import type { SandboxEvent } from '../types/events.js';
import type { RulesDisposition } from '../types/operation.js';

const DEFAULT_MAX_DENIAL_EVENTS = 1_000;
const DEFAULT_MAX_DENIAL_BYTES = 2 * 1024 * 1024;
const QUEUE_COMPACT_THRESHOLD = 256;

export interface EventHistoryLimits extends BaseEventHistoryLimits {
  maxDenialEvents?: number;
  maxDenialBytes?: number;
}

export interface DenialLaneLimits {
  maxEvents: number;
  maxBytes: number;
}

type HistoryLane = 'general' | 'denial';

export interface HistoryEntry {
  event: SandboxEvent;
  bytes: number;
  seq: number;
  lane: HistoryLane;
}

function isDeniedDisposition(disposition: RulesDisposition | undefined): boolean {
  if (disposition === undefined) return false;
  if (disposition.kind === 'evaluated') return disposition.verdict === 'deny';
  if (disposition.kind === 'not-evaluated') {
    return disposition.reason === 'unsupported' || disposition.reason === 'runtime-error';
  }
  return false;
}

/** Denials and runtime or listener errors share a protected bounded lane. */
export function isDenialOrErrorEvent(event: SandboxEvent): boolean {
  if (event.kind === 'runtime_error' || event.kind === 'listener_errored') return true;
  if (event.kind === 'request') {
    if (event.result === 'deny' || event.result === 'unsupported') return true;
    return isDeniedDisposition(event.rulesDisposition);
  }
  if (event.kind === 'operation') {
    if (event.result === 'deny' || event.result === 'error' || event.result === 'unsupported') {
      return true;
    }
    if (isDeniedDisposition(event.rulesDisposition)) return true;
    if (event.observation?.status === 'failed') return true;
    return event.production?.outcome.status === 'error';
  }
  if (event.kind === 'listener') {
    if (
      event.phase === 'errored'
      || event.result === 'deny'
      || event.result === 'error'
      || event.result === 'unsupported'
    ) {
      return true;
    }
    return isDeniedDisposition(event.rulesDisposition);
  }
  if (event.kind === 'service_mutation') {
    if (event.service === 'ai') return event.op === 'request_rejected';
    if (event.service === 'messaging') return event.op === 'message_rejected';
    return false;
  }
  return false;
}

/** Clamps denial-lane bounds inside the overall history capacity. */
export function resolveDenialLaneLimits(
  limits: EventHistoryLimits | undefined,
): DenialLaneLimits | undefined {
  if (limits === undefined) return undefined;
  const requestedEvents = limits.maxDenialEvents ?? DEFAULT_MAX_DENIAL_EVENTS;
  const requestedBytes = limits.maxDenialBytes ?? DEFAULT_MAX_DENIAL_BYTES;
  return {
    maxEvents: Math.max(0, Math.min(requestedEvents, limits.maxEvents)),
    maxBytes: Math.max(0, Math.min(requestedBytes, limits.maxBytes)),
  };
}

class EntryQueue {
  private items: Array<HistoryEntry | undefined> = [];
  private head = 0;
  private bytes = 0;

  get length(): number {
    return this.items.length - this.head;
  }

  get totalBytes(): number {
    return this.bytes;
  }

  push(entry: HistoryEntry): void {
    this.items.push(entry);
    this.bytes += entry.bytes;
  }

  shift(): HistoryEntry | undefined {
    if (this.head >= this.items.length) return undefined;
    const entry = this.items[this.head];
    this.items[this.head] = undefined;
    this.head += 1;
    if (this.head > QUEUE_COMPACT_THRESHOLD && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    if (entry !== undefined) this.bytes -= entry.bytes;
    return entry;
  }

  adjustBytes(delta: number): void {
    this.bytes += delta;
  }

  at(offset: number): HistoryEntry | undefined {
    return this.items[this.head + offset];
  }

  clear(): void {
    this.items = [];
    this.head = 0;
    this.bytes = 0;
  }
}

/**
 * Two-lane bounded queue keeping denials and errors isolated from allowed
 * traffic while reconstructing chronological arrival order on snapshot reads.
 */
export class EventHistoryLanes {
  private readonly general = new EntryQueue();
  private readonly denials = new EntryQueue();
  private nextSeq = 0;

  get totalCount(): number {
    return this.general.length + this.denials.length;
  }

  get totalBytes(): number {
    return this.general.totalBytes + this.denials.totalBytes;
  }

  get denialCount(): number {
    return this.denials.length;
  }

  get denialBytes(): number {
    return this.denials.totalBytes;
  }

  push(event: SandboxEvent, bytes: number): HistoryEntry {
    let lane: HistoryLane = 'general';
    if (isDenialOrErrorEvent(event)) lane = 'denial';
    const entry: HistoryEntry = { event, bytes, seq: this.nextSeq, lane };
    this.nextSeq += 1;
    if (lane === 'denial') {
      this.denials.push(entry);
    } else {
      this.general.push(entry);
    }
    return entry;
  }

  updateBytes(entry: HistoryEntry, nextBytes: number): void {
    const delta = nextBytes - entry.bytes;
    if (entry.lane === 'denial') {
      this.denials.adjustBytes(delta);
    } else {
      this.general.adjustBytes(delta);
    }
    entry.bytes = nextBytes;
  }

  shiftDenial(): HistoryEntry | undefined {
    return this.denials.shift();
  }

  /** Evicts allowed traffic first so routine writes cannot push out retained denials. */
  shiftForTotalBudget(): HistoryEntry | undefined {
    if (this.general.length > 0) return this.general.shift();
    return this.denials.shift();
  }

  snapshotEvents(): SandboxEvent[] {
    const generalLen = this.general.length;
    const denialLen = this.denials.length;
    const merged: SandboxEvent[] = [];
    let generalIndex = 0;
    let denialIndex = 0;
    while (generalIndex < generalLen && denialIndex < denialLen) {
      const generalEntry = this.general.at(generalIndex);
      const denialEntry = this.denials.at(denialIndex);
      if (generalEntry === undefined || denialEntry === undefined) break;
      if (generalEntry.seq <= denialEntry.seq) {
        merged.push(generalEntry.event);
        generalIndex += 1;
      } else {
        merged.push(denialEntry.event);
        denialIndex += 1;
      }
    }
    while (generalIndex < generalLen) {
      const generalEntry = this.general.at(generalIndex);
      if (generalEntry !== undefined) merged.push(generalEntry.event);
      generalIndex += 1;
    }
    while (denialIndex < denialLen) {
      const denialEntry = this.denials.at(denialIndex);
      if (denialEntry !== undefined) merged.push(denialEntry.event);
      denialIndex += 1;
    }
    return merged;
  }

  clear(): void {
    this.general.clear();
    this.denials.clear();
    this.nextSeq = 0;
  }
}
