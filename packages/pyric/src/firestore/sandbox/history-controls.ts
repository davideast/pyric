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
    const hasEvent = event !== null;
    const missingEvent = !hasEvent;
    if (missingEvent) return null;
    const priors = event.priorDocs;
    const snapshot = event.snapshot;
    const hasPriors = priors !== undefined;
    const hasSnapshot = snapshot !== undefined;
    if (hasPriors) this.host.state.restorePaths(priors);
    else if (hasSnapshot) this.host.state.restore(snapshot);
    else return null;
    return event;
  }

  /** Durable redo restores exact values; other environments retain write replay. */
  redo(): OperationResult | null {
    const event = this.eventLog.popLastUndo();
    const hasEvent = event !== null;
    const missingEvent = !hasEvent;
    if (missingEvent) return null;
    const exactResult = event.nextDocs;
    const hasExactResult = exactResult !== undefined;
    const operations = event.operations;
    const isBatch = event.type === 'batch' && operations !== undefined;
    let affectedPaths: string[] = [];
    if (hasExactResult) affectedPaths = Object.keys(exactResult);
    else if (isBatch) affectedPaths = operations.map(operation => operation.path);
    else {
      const hasPath = event.path.length > 0;
      if (hasPath) affectedPaths = [event.path];
    }
    const useFullSnapshot = event.snapshot !== undefined;
    const priorDocs = useFullSnapshot ? undefined : this.host.capturePriors(affectedPaths);
    const snapshot = useFullSnapshot ? this.host.state.snapshot() : undefined;
    if (hasExactResult) this.host.state.restorePaths(exactResult);
    else if (isBatch) {
      for (const operation of operations) {
        const allowed = operation.allowed;
        if (allowed) this.host.applyWrite(operation.method, operation.path, operation.data);
      }
    } else {
      const allowed = event.allowed;
      if (allowed) this.host.applyWrite(event.method, event.path, event.data);
    }
    const restored = this.eventLog.append({ ...event, priorDocs, snapshot }, true);
    const wasAllowed = event.allowed;
    const outcome = wasAllowed ? 'applied' : 'skipped (was denied)';
    return { allowed: event.allowed, debugMessages: [`Redo: ${outcome}`], event: restored };
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
