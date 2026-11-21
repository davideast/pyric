/**
 * Coalesces synchronous `WriteBatch` and `runTransaction` sub-operations
 * sharing a `groupId` into one net `(before, after)` commit per document path
 * while preserving strict FIFO ordering with surrounding single writes.
 */
import type { FirestoreTimestampValue } from './document-change.js';

export interface RawFirestoreWriteInput<TMeta = undefined> {
  readonly database: string;
  readonly document: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly commitTime: FirestoreTimestampValue;
  readonly groupId?: string;
  readonly meta?: TMeta;
}

export interface CoalescedFirestoreWrite<TMeta = undefined> {
  readonly database: string;
  readonly document: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly commitTime: FirestoreTimestampValue;
  readonly meta?: TMeta;
}

export class WriteGroupCoalescer<TMeta = undefined> {
  readonly #onCommit: (commit: CoalescedFirestoreWrite<TMeta>) => void;
  #activeGroupId: string | null = null;
  readonly #buffered = new Map<string, CoalescedFirestoreWrite<TMeta>>();
  #closed = false;

  constructor(onCommit: (commit: CoalescedFirestoreWrite<TMeta>) => void) {
    this.#onCommit = onCommit;
  }

  push(write: RawFirestoreWriteInput<TMeta>): void {
    if (this.#closed) return;
    const groupId = write.groupId;
    if (groupId === undefined || groupId.length === 0) {
      this.flush();
      const single: CoalescedFirestoreWrite<TMeta> = {
        database: write.database,
        document: write.document,
        before: write.before,
        after: write.after,
        commitTime: write.commitTime,
        meta: write.meta,
      };
      this.#onCommit(single);
      return;
    }
    if (this.#activeGroupId !== null && this.#activeGroupId !== groupId) {
      this.flush();
    }
    const isNewGroup = this.#activeGroupId === null;
    this.#activeGroupId = groupId;
    const docKey = `${write.database}\0${write.document}`;
    const existing = this.#buffered.get(docKey);
    let before = write.before;
    if (existing !== undefined) {
      before = existing.before;
    }
    this.#buffered.set(docKey, {
      database: write.database,
      document: write.document,
      before,
      after: write.after,
      commitTime: write.commitTime,
      meta: write.meta,
    });
    if (isNewGroup) {
      const scheduledGroupId = groupId;
      queueMicrotask(() => {
        if (!this.#closed && this.#activeGroupId === scheduledGroupId) {
          this.flush();
        }
      });
    }
  }

  flush(): void {
    if (this.#activeGroupId === null) return;
    this.#activeGroupId = null;
    const commits = [...this.#buffered.values()];
    this.#buffered.clear();
    for (const commit of commits) {
      if (this.#closed) return;
      this.#onCommit(commit);
    }
  }

  reset(): void {
    this.#activeGroupId = null;
    this.#buffered.clear();
  }

  close(): void {
    this.#closed = true;
    this.reset();
  }
}
