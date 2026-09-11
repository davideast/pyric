/**
 * The record of runs `fire` caused, one log per sandbox.
 *
 * The runtime this package wraps had no execution log before this file: the
 * real dev runtime only ever reports an execution to a log line
 * (`vite-functions-development.ts`'s `reportEvent`) and forgets it. A synthetic
 * call needs somewhere to read that history back from, so this is a small,
 * one-file seam added to the runtime rather than a claim about a log that
 * already existed.
 *
 * The store is keyed on the sandbox rather than held as one process-wide
 * value, the same reason `assurance-campaigns.ts` keys its campaign store on
 * the sandbox: a second sandbox in the same process, which is what a test
 * suite is, never sees another sandbox's executions.
 */
import type { LocalSandbox } from 'pyric/sandbox';

/** One run `fire` caused. */
export interface FunctionExecutionRecord {
  /** Stable id, assigned in log order. */
  id: string;
  /** The trigger export name `fire` ran. */
  trigger: string;
  /** The concrete path and params the synthetic event carried. */
  cause: { ref: string; params: Record<string, string> };
  /** Sandbox clock instant the run started, in epoch milliseconds. */
  startedAt: number;
  durationMs: number;
  status: 'fulfilled' | 'rejected' | 'timeout';
  /** What the handler returned, present only when `status` is `fulfilled`. */
  result?: unknown;
  /** The handler's thrown error, present only when `status` is `rejected`. */
  error?: string;
}

/** What `fire` reports to the log once a run finishes. */
export type FunctionExecutionEntry = Omit<FunctionExecutionRecord, 'id'>;

export class FunctionsExecutionLog {
  #records: FunctionExecutionRecord[] = [];
  #sequence = 0;

  /** Append one finished run and return the record it was stored as. */
  record(entry: FunctionExecutionEntry): FunctionExecutionRecord {
    this.#sequence += 1;
    const stored: FunctionExecutionRecord = { id: String(this.#sequence), ...entry };
    this.#records.push(stored);
    return stored;
  }

  /** Every run at or after `since`, in the order they finished. */
  list(since?: number): FunctionExecutionRecord[] {
    if (since === undefined) return [...this.#records];
    return this.#records.filter((record) => record.startedAt >= since);
  }
}

/** One execution log per sandbox, created the first time a call reaches it. */
const LOGS = new WeakMap<LocalSandbox, FunctionsExecutionLog>();

/** The execution log this sandbox holds. */
export function executionLogFor(sandbox: LocalSandbox): FunctionsExecutionLog {
  const existing = LOGS.get(sandbox);
  if (existing !== undefined) return existing;
  const created = new FunctionsExecutionLog();
  LOGS.set(sandbox, created);
  return created;
}
