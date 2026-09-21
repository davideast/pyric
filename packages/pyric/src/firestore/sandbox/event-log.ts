/**
 * Event Log — bounded audit and undo history for the local environment.
 *
 * Operations (allowed or denied) are retained within count and byte limits. Undo is implemented
 * via state snapshots — no need to replay events.
 */
import type { DocumentData } from './local-state.js';
import { encodedBytes, type EventHistoryLimits } from '../../sandbox/internal/history-retention.js';
import { OBSERVATION_HISTORY_LIMITS } from '../../sandbox/internal/observation-history.js';
import { SandboxClock } from '../../sandbox/clock.js';

export interface AgentEvent {
  id: number;
  timestamp: string;
  type: 'single' | 'batch' | 'transaction';
  method: string;
  path: string;
  auth: { uid: string } | null;
  allowed: boolean;
  /** For writes: the data that was written */
  data?: DocumentData;
  /** For batch/transaction: individual operations */
  operations?: Array<{
    method: string;
    path: string;
    data?: DocumentData;
    allowed: boolean;
  }>;
  /**
   * For transactions: the read-set captured by tx.get / tx.getAll inside
   * the callback. Surfaced for diagnostic value (production doesn't
   * expose this, but agents debugging "why did my tx commit nothing"
   * benefit from seeing what the callback saw).
   */
  reads?: Array<{ path: string; data: DocumentData | null }>;
  /**
   * For transactions: true iff the callback threw (read-after-write
   * violation, ambiguous post-delete, or any user error). Aborted
   * transactions are NOT undoable — they had no effect, popping them as
   * undoable would skip a real prior write.
   */
  aborted?: boolean;
  /**
   * For transactions: the error that aborted the callback (when
   * `aborted: true`). Recorded for forensic value; the original Error
   * is also re-thrown synchronously to the caller (probe 0.G —
   * exceptions propagate unchanged).
   */
  error?: { name: string; message: string; code?: string };
  /**
   * Prior state of the AFFECTED paths only, captured before this event, for
   * undo (single-write + batch). `null` means the doc did not exist (undo
   * deletes it). Replaces the whole-keyspace {@link snapshot} for the common
   * write paths so the undo stack is O(affected) not O(keyspace).
   */
  priorDocs?: Record<string, DocumentData | null>;
  /**
   * Whole-keyspace snapshot BEFORE this event (for undo). Still used by
   * transactions, whose affected paths aren't known until the callback runs.
   */
  snapshot?: Record<string, DocumentData>;
  /** Debug messages from rules evaluation */
  debugMessages: string[];
}

export interface EventLogRetention {
  retainedEvents: number;
  retainedBytes: number;
  omittedCount: number;
}

export class EventLog {
  private events: AgentEvent[] = [];
  private nextId = 1;
  private undoneEvents: AgentEvent[] = [];
  private readonly eventBytes = new Map<number, number>();
  private retainedBytes = 0;
  private omittedCount = 0;

  /** @param clock The sandbox clock every appended entry is stamped from. */
  constructor(
    private readonly clock: SandboxClock = new SandboxClock(),
    private readonly limits: EventHistoryLimits = OBSERVATION_HISTORY_LIMITS,
  ) {}

  /** Append an event. Clears redo stack unless preserveRedo is true. */
  append(event: Omit<AgentEvent, 'id' | 'timestamp'>, preserveRedo = false): AgentEvent {
    const full: AgentEvent = {
      ...event,
      id: this.nextId++,
      timestamp: new Date(this.clock.now()).toISOString(),
    };
    if (!preserveRedo) {
      for (const undone of this.undoneEvents) this.release(undone);
      this.undoneEvents = [];
    }
    this.events.push(full);
    const bytes = encodedBytes(full) + 1;
    this.eventBytes.set(full.id, bytes);
    this.retainedBytes += bytes;
    this.prune();
    return full;
  }

  /** Get retained events in their original order. */
  getEvents(): AgentEvent[] {
    return [...this.events];
  }

  /** Get write events only (create, update, delete, set — not reads). */
  getWriteEvents(): AgentEvent[] {
    return this.events.filter(e => e.allowed && e.method !== 'get' && e.method !== 'list');
  }

  /** Get the last write event (for undo). */
  lastWriteEvent(): AgentEvent | null {
    const writes = this.getWriteEvents();
    return writes.length > 0 ? writes[writes.length - 1] : null;
  }

  /**
   * Pop the last write event for undo. Pushes to redo stack.
   *
   * Aborted transactions are skipped — they had no effect on state, so
   * popping one as if it were undoable would silently leave a real
   * prior write in place while the agent thinks it has been reverted.
   * Aborted events stay in the log for forensic value (`getEvents()`
   * still returns them) but do not enter the undo stack.
   */
  popLastWrite(): AgentEvent | null {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.aborted) continue;
      if (e.allowed && e.method !== 'get' && e.method !== 'list') {
        this.events.splice(i, 1);
        this.undoneEvents.push(e);
        return e;
      }
    }
    return null;
  }

  /** Get the last undone event (for redo). */
  popLastUndo(): AgentEvent | null {
    const event = this.undoneEvents.pop();
    if (!event) return null;
    this.release(event);
    return event;
  }

  /** Shared accounting for the visible log and redo stack. */
  getRetention(): EventLogRetention {
    return {
      retainedEvents: this.eventBytes.size,
      retainedBytes: this.retainedBytes,
      omittedCount: this.omittedCount,
    };
  }

  private release(event: AgentEvent): void {
    this.retainedBytes -= this.eventBytes.get(event.id) ?? 0;
    this.eventBytes.delete(event.id);
    // An unserializable event has infinite estimated size; removing the final
    // retained entry must reset accounting rather than leave Infinity - Infinity.
    const isEmpty = this.eventBytes.size === 0;
    if (isEmpty) this.retainedBytes = 0;
  }

  private prune(): void {
    const exceedsBudget = () => this.eventBytes.size > this.limits.maxEvents
      || this.retainedBytes > this.limits.maxBytes;
    while (exceedsBudget()) {
      // Accounting preserves append order even when undo/redo reorders stacks.
      const oldestId = this.eventBytes.keys().next().value;
      const oldestIsUndone = this.events[0]?.id !== oldestId;
      const entries = oldestIsUndone ? this.undoneEvents : this.events;
      const index = oldestIsUndone ? entries.findIndex(event => event.id === oldestId) : 0;
      const [omitted] = entries.splice(index, 1);
      if (!omitted) break;
      this.release(omitted);
      this.omittedCount++;
    }
  }

  /** Visible event count; undone events remain accounted in getRetention(). */
  size(): number {
    return this.events.length;
  }

  /** Clear all events. */
  clear(): void {
    this.events = [];
    this.undoneEvents = [];
    this.nextId = 1;
    this.eventBytes.clear();
    this.retainedBytes = 0;
    this.omittedCount = 0;
  }
}
