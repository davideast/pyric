/**
 * HistoryControls — undo/redo and event-log access for the Firestore
 * sandbox engine (ADR-0009, PR B1).
 *
 * Undo/redo is not a thin log wrapper: redo re-applies writes and captures
 * priors for a future undo. Those operations belong to the engine's write
 * application, so the module receives them as an injected {@link HistoryHost}
 * slice — narrow enough that unit tests drive undo/redo against fakes
 * without constructing the engine.
 */
import type { DocumentData } from './local-state.js';
import type { EventLog, AgentEvent } from './event-log.js';
import type { OperationResult } from './writes.js';
import type { FirestoreSimError } from './errors.js';

/** The engine capabilities undo/redo needs — nothing more. `state` is a
 *  getter because `seed()` replaces the engine's keyspace object. */
export interface HistoryHost {
  readonly state: {
    snapshot(): Record<string, DocumentData>;
    restore(snapshot: Record<string, DocumentData>): void;
    restorePaths(priorDocs: Record<string, DocumentData | null>): void;
  };
  capturePriors(paths: readonly string[]): Record<string, DocumentData | null>;
  applyWrite(
    method: string,
    path: string,
    data?: DocumentData,
    merge?: boolean | { mergeFields: readonly string[] },
  ): FirestoreSimError | null;
}

export class HistoryControls {
  constructor(
    private readonly eventLog: EventLog,
    private readonly host: HistoryHost,
  ) {}

  /** Undo the last write operation. Restores the affected paths (single-write /
   *  batch) or the whole keyspace (transaction) to their pre-write state. */
  undo(): AgentEvent | null {
    const event = this.eventLog.popLastWrite();
    if (!event) return null;
    if (event.priorDocs) this.host.state.restorePaths(event.priorDocs);
    else if (event.snapshot) this.host.state.restore(event.snapshot);
    else return null;
    return event;
  }

  /** Redo the last undone operation. Re-applies the write directly
   *  without going through execute() (which would clear the redo stack). */
  redo(): OperationResult | null {
    const event = this.eventLog.popLastUndo();
    if (!event) return null;

    // Capture prior state BEFORE re-applying (for a future undo of this redo),
    // matching the kind the event used: affected paths for single-write / batch,
    // the whole keyspace for a transaction.
    const affectedPaths = (event.type === 'batch' && event.operations)
      ? event.operations.map((op) => op.path)
      : event.path ? [event.path] : [];
    const useFullSnapshot = !!event.snapshot;
    const priorDocs = useFullSnapshot ? undefined : this.host.capturePriors(affectedPaths);
    const snapshot = useFullSnapshot ? this.host.state.snapshot() : undefined;

    // Re-apply the write directly to state
    if (event.type === 'batch' && event.operations) {
      for (const op of event.operations) {
        if (op.allowed) this.host.applyWrite(op.method, op.path, op.data);
      }
    } else if (event.allowed) {
      this.host.applyWrite(event.method, event.path, event.data);
    }

    // Re-append with preserveRedo=true so remaining redos aren't lost
    const newEvent = this.eventLog.append({
      ...event,
      snapshot,
      priorDocs,
    }, true);

    return {
      allowed: event.allowed,
      debugMessages: ['Redo: ' + (event.allowed ? 'applied' : 'skipped (was denied)')],
      event: newEvent,
    };
  }

  /** Get all events. */
  getEvents(): AgentEvent[] {
    return this.eventLog.getEvents();
  }

  /** Get event count. */
  getEventCount(): number {
    return this.eventLog.size();
  }
}
