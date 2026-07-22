/**
 * Item 1.2 — `Transaction` callback class.
 *
 * The class agents see inside their `runTransaction` callback. Its job
 * is narrow:
 *
 *   1. Capture reads (admin-mode, no rules) via an injected reader
 *      callback. This decouples the class from `LocalEnvironment` for
 *      testability — Item 2 binds the reader to `this.getDocument`.
 *   2. Queue writes append-only. The merge / atomic-apply / rules-eval
 *      all happen *after* the callback returns, in `LocalEnvironment.
 *      transaction()` (Item 2.1).
 *   3. Enforce global read-before-write ordering — once any write
 *      method runs, every subsequent `get` / `getAll` throws. This is
 *      the locked Admin SDK behavior (probes 0.A + 0.J).
 *
 * The class is single-use: a fresh instance is constructed per call to
 * `LocalEnvironment.transaction(...)`. After the callback returns,
 * `consume()` hands the captured reads + queued writes to the commit
 * path and the instance is discarded.
 */
import type { DocumentData } from './local-state.js';
import { makeError, type FirestoreSimError } from './errors.js';
import {
  READ_AFTER_WRITE_MESSAGE,
  type CapturedRead,
  type QueuedWrite,
  type Transaction,
  type TransactionSnapshot,
} from './transaction-types.js';

/**
 * Reader signature. Returns the document at `path` or `null` if it
 * doesn't exist. Bound at construction time; the class itself doesn't
 * know whether the reader hits `LocalState`, a stub, or a remote.
 */
export type TransactionReader = (path: string) => DocumentData | null;
export type TransactionVersionReader = (path: string) => number;

/**
 * Thrown synchronously by `tx.get` / `tx.getAll` when called after
 * any write method. Maps cleanly to the simulator's typed-error
 * surface — callers in Item 2 catch this, translate to
 * `FirestoreSimError { code: 'failed-precondition' }`, and re-raise.
 *
 * Carrying a typed error class (rather than a plain `Error`) lets the
 * commit path discriminate from arbitrary user throws (probe 0.G:
 * those propagate unchanged) without instanceof-checking message
 * strings.
 */
export class ReadAfterWriteError extends Error {
  readonly simError: FirestoreSimError;
  constructor() {
    super(READ_AFTER_WRITE_MESSAGE);
    this.name = 'ReadAfterWriteError';
    this.simError = makeError('failed-precondition', READ_AFTER_WRITE_MESSAGE);
  }
}

/** Internal signal: a document read by this attempt changed before commit. */
export class RetryableTransactionConflictError extends Error {
  constructor() {
    super('A document read in the transaction changed before commit.');
    this.name = 'RetryableTransactionConflictError';
  }
}

/** Raised after the configured transaction attempts are exhausted. */
export class TransactionAttemptsExhaustedError extends Error {
  readonly simError = makeError('failed-precondition', 'Transaction failed all retries.');

  constructor() {
    super('Transaction failed all retries.');
    this.name = 'TransactionAttemptsExhaustedError';
  }
}

/**
 * Single-use transaction context. See file header for design notes.
 */
export class TransactionContext implements Transaction {
  private readonly reader: TransactionReader;
  private readonly reads: CapturedRead[] = [];
  private readonly writes: QueuedWrite[] = [];
  private readonly readVersions = new Map<string, number>();
  private writeStarted = false;

  constructor(
    reader: TransactionReader,
    private readonly versionReader: TransactionVersionReader = () => 0,
  ) {
    this.reader = reader;
  }

  // ─── Reads ────────────────────────────────────────────────────────

  get(path: string): TransactionSnapshot {
    this.assertReadsAllowed();
    const data = this.reader(path);
    if (!this.readVersions.has(path)) {
      this.readVersions.set(path, this.versionReader(path));
    }
    this.reads.push({ path, data });
    // Capture-by-value: callbacks that mutate `data()` later don't
    // poison the captured read set. Cheap (small docs) and matches
    // production semantics where the snapshot is immutable.
    const captured = data === null ? null : structuredClone(data);
    return {
      path,
      exists: captured !== null,
      data: () => (captured === null ? undefined : captured),
    };
  }

  getAll(...paths: string[]): TransactionSnapshot[] {
    this.assertReadsAllowed();
    // Order-preserving: probe 0.C confirmed Admin returns snapshots
    // in input order. We mirror that by mapping in place.
    return paths.map(p => this.get(p));
  }

  // ─── Writes ───────────────────────────────────────────────────────

  set(path: string, data: DocumentData): void {
    this.queue({ method: 'set', path, data });
  }
  create(path: string, data: DocumentData): void {
    this.queue({ method: 'create', path, data });
  }
  update(path: string, data: DocumentData): void {
    this.queue({ method: 'update', path, data });
  }
  delete(path: string): void {
    this.queue({ method: 'delete', path });
  }

  // ─── Internal — used by Item 2's commit path ──────────────────────

  /**
   * Hand reads + queued writes to the commit path. After this is
   * called the instance is dead — further calls would corrupt the
   * commit. Item 2 calls this exactly once after the callback returns.
   */
  consume(): {
    reads: readonly CapturedRead[];
    writes: readonly QueuedWrite[];
    readVersions: ReadonlyMap<string, number>;
  } {
    return { reads: this.reads, writes: this.writes, readVersions: this.readVersions };
  }

  /**
   * True iff any write method has been called. Item 2.3 checks this
   * after the callback returns to populate `readOnlyViolation` when
   * the tx was started with `readOnly: true`.
   */
  hadWrites(): boolean {
    return this.writeStarted;
  }

  // ─── Private ──────────────────────────────────────────────────────

  private queue(write: QueuedWrite): void {
    this.writeStarted = true;
    this.writes.push(write);
  }

  private assertReadsAllowed(): void {
    if (this.writeStarted) {
      throw new ReadAfterWriteError();
    }
  }
}
