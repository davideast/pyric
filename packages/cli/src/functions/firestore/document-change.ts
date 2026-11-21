/**
 * Firestore document mutation lifecycle classification and per-document
 * createTime / updateTime continuity tracking across creates, updates,
 * deletes, and re-creates.
 */
import {
  areFirestoreDocumentsEqual,
  computeDocumentUpdateMask,
} from './value-equality.js';

export interface FirestoreTimestampValue {
  readonly seconds: number;
  readonly nanoseconds: number;
}

interface FirestoreDocumentVersion {
  readonly fields: Record<string, unknown>;
  readonly createTime: FirestoreTimestampValue;
  readonly updateTime: FirestoreTimestampValue;
}

export type FirestoreTransitionKind = 'created' | 'updated' | 'deleted';

export type FirestoreNetClassification =
  | { readonly kind: 'noop' }
  | {
      readonly kind: 'created';
      readonly before: null;
      readonly after: Record<string, unknown>;
    }
  | {
      readonly kind: 'updated';
      readonly before: Record<string, unknown>;
      readonly after: Record<string, unknown>;
      readonly updateMask: readonly string[];
    }
  | {
      readonly kind: 'deleted';
      readonly before: Record<string, unknown>;
      readonly after: null;
    };

export interface FirestoreDocumentTransition {
  readonly kind: FirestoreTransitionKind;
  readonly database: string;
  readonly document: string;
  readonly before: FirestoreDocumentVersion | null;
  readonly after: FirestoreDocumentVersion | null;
  readonly updateMask: readonly string[];
  readonly time: FirestoreTimestampValue;
}

/** Classify a net `(before, after)` document state pair, suppressing no-ops. */
export function classifyDocumentTransition(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): FirestoreNetClassification {
  if (before === null && after === null) {
    return { kind: 'noop' };
  }
  if (before === null && after !== null) {
    return { kind: 'created', before: null, after };
  }
  if (before !== null && after === null) {
    return { kind: 'deleted', before, after: null };
  }
  const existingBefore = before as Record<string, unknown>;
  const existingAfter = after as Record<string, unknown>;
  if (areFirestoreDocumentsEqual(existingBefore, existingAfter)) {
    return { kind: 'noop' };
  }
  return {
    kind: 'updated',
    before: existingBefore,
    after: existingAfter,
    updateMask: computeDocumentUpdateMask(existingBefore, existingAfter),
  };
}

/** Whether a discovered v2 Firestore event type fires on `kind`. */
export function triggerMatchesTransitionKind(
  eventType: string,
  kind: FirestoreTransitionKind,
): boolean {
  if (
    eventType === 'google.cloud.firestore.document.v1.written' ||
    eventType === 'google.cloud.firestore.document.v1.written.withAuthContext'
  ) {
    return true;
  }
  if (
    eventType === 'google.cloud.firestore.document.v1.created' ||
    eventType === 'google.cloud.firestore.document.v1.created.withAuthContext'
  ) {
    return kind === 'created';
  }
  if (
    eventType === 'google.cloud.firestore.document.v1.updated' ||
    eventType === 'google.cloud.firestore.document.v1.updated.withAuthContext'
  ) {
    return kind === 'updated';
  }
  if (
    eventType === 'google.cloud.firestore.document.v1.deleted' ||
    eventType === 'google.cloud.firestore.document.v1.deleted.withAuthContext'
  ) {
    return kind === 'deleted';
  }
  return false;
}

/**
 * Tracks per-document `{ createTime, updateTime }` across creates, updates,
 * deletes, and re-creates, while suppressing no-op mutations.
 */
export class DocumentLifecycleTracker {
  readonly #timestamps = new Map<
    string,
    { createTime: FirestoreTimestampValue; updateTime: FirestoreTimestampValue }
  >();

  #key(database: string, document: string): string {
    return `${database}\0${document}`;
  }

  /** Seed historical write state at subscription attach without emitting triggers. */
  seedFromWrite(
    database: string,
    document: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
    commitTime: FirestoreTimestampValue,
  ): void {
    const key = this.#key(database, document);
    if (after === null) {
      this.#timestamps.delete(key);
      return;
    }
    if (before === null) {
      this.#timestamps.set(key, { createTime: commitTime, updateTime: commitTime });
      return;
    }
    if (areFirestoreDocumentsEqual(before, after)) {
      if (!this.#timestamps.has(key)) {
        this.#timestamps.set(key, { createTime: commitTime, updateTime: commitTime });
      }
      return;
    }
    const existing = this.#timestamps.get(key);
    let createTime = commitTime;
    if (existing !== undefined) {
      createTime = existing.createTime;
    }
    this.#timestamps.set(key, { createTime, updateTime: commitTime });
  }

  /** Apply a live mutation and return the triggerable transition, or null on no-op. */
  applyWrite(
    database: string,
    document: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
    commitTime: FirestoreTimestampValue,
  ): FirestoreDocumentTransition | null {
    const net = classifyDocumentTransition(before, after);
    if (net.kind === 'noop') {
      return null;
    }
    const key = this.#key(database, document);
    if (net.kind === 'created') {
      this.#timestamps.set(key, { createTime: commitTime, updateTime: commitTime });
      return {
        kind: 'created',
        database,
        document,
        before: null,
        after: {
          fields: net.after,
          createTime: commitTime,
          updateTime: commitTime,
        },
        updateMask: [],
        time: commitTime,
      };
    }
    const priorTimestamps = this.#timestamps.get(key) ?? {
      createTime: commitTime,
      updateTime: commitTime,
    };
    if (net.kind === 'deleted') {
      this.#timestamps.delete(key);
      return {
        kind: 'deleted',
        database,
        document,
        before: {
          fields: net.before,
          createTime: priorTimestamps.createTime,
          updateTime: priorTimestamps.updateTime,
        },
        after: null,
        updateMask: [],
        time: commitTime,
      };
    }
    this.#timestamps.set(key, {
      createTime: priorTimestamps.createTime,
      updateTime: commitTime,
    });
    return {
      kind: 'updated',
      database,
      document,
      before: {
        fields: net.before,
        createTime: priorTimestamps.createTime,
        updateTime: priorTimestamps.updateTime,
      },
      after: {
        fields: net.after,
        createTime: priorTimestamps.createTime,
        updateTime: commitTime,
      },
      updateMask: net.updateMask,
      time: commitTime,
    };
  }

  clear(): void {
    this.#timestamps.clear();
  }
}
