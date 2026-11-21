/**
 * Deterministic in-memory Firestore mutation delivery adapter for unit tests.
 */
import { DEFAULT_FIRESTORE_DATABASE } from './discovery.js';
import { normalizeFirestoreDocumentPath } from './document-pattern.js';
import type {
  FirestoreDeliveryCallbacks,
  FirestoreMutationRecord,
  FirestoreTriggerDelivery,
} from './delivery.js';
import type { FirestoreDocumentVersion } from './event.js';
import type { FirestoreTimestampProto } from './proto-encoder.js';
import {
  areFirestoreDocumentsEqual,
  computeDocumentUpdateMask,
} from './value-equality.js';

export interface InMemoryCreateCommitInput {
  readonly database?: string;
  readonly document: string;
  readonly fields: Record<string, unknown>;
  readonly time?: string;
  readonly createTime?: FirestoreTimestampProto;
  readonly updateTime?: FirestoreTimestampProto;
}

export interface InMemoryUpdateCommitInput {
  readonly database?: string;
  readonly document: string;
  readonly fields: Record<string, unknown>;
  readonly time?: string;
  readonly updateTime?: FirestoreTimestampProto;
}

export interface InMemoryDeleteCommitInput {
  readonly database?: string;
  readonly document: string;
  readonly time?: string;
}

function isoToTimestampProto(iso: string): FirestoreTimestampProto {
  const millis = new Date(iso).getTime();
  const seconds = Math.floor(millis / 1_000);
  const nanos = (millis - seconds * 1_000) * 1_000_000;
  return { seconds, nanos };
}

export class InMemoryFirestoreTriggerDelivery implements FirestoreTriggerDelivery {
  readonly #subscribers = new Map<string, Set<FirestoreDeliveryCallbacks>>();
  readonly #documents = new Map<string, FirestoreDocumentVersion>();

  seed(
    document: string,
    fields: Record<string, unknown>,
    options: { database?: string; timestamp?: FirestoreTimestampProto } = {},
  ): void {
    const database = options.database ?? DEFAULT_FIRESTORE_DATABASE;
    const normalized = normalizeFirestoreDocumentPath(document);
    const ts = options.timestamp ?? { seconds: 1_700_000_000, nanos: 0 };
    this.#documents.set(`${database}\u0000${normalized}`, {
      fields: { ...fields },
      createTime: ts,
      updateTime: ts,
    });
  }

  emitMutation(mutation: FirestoreMutationRecord): void {
    const normalized = normalizeFirestoreDocumentPath(mutation.document);
    if (mutation.before === null && mutation.after === null) {
      return;
    }
    if (
      mutation.before !== null &&
      mutation.after !== null &&
      areFirestoreDocumentsEqual(mutation.before.fields, mutation.after.fields)
    ) {
      return;
    }
    const key = `${mutation.database}\u0000${normalized}`;
    if (mutation.after === null) {
      this.#documents.delete(key);
    } else {
      this.#documents.set(key, mutation.after);
    }
    const normalizedMutation: FirestoreMutationRecord = {
      ...mutation,
      document: normalized,
    };
    if (
      normalizedMutation.updateMask === undefined &&
      mutation.before !== null &&
      mutation.after !== null
    ) {
      normalizedMutation.updateMask = computeDocumentUpdateMask(
        mutation.before.fields,
        mutation.after.fields,
      );
    }
    const listeners = this.#subscribers.get(mutation.database);
    if (listeners === undefined) return;
    for (const callbacks of listeners) {
      callbacks.onMutation(normalizedMutation);
    }
  }

  emitCreate(input: InMemoryCreateCommitInput): void {
    const database = input.database ?? DEFAULT_FIRESTORE_DATABASE;
    const normalized = normalizeFirestoreDocumentPath(input.document);
    const key = `${database}\u0000${normalized}`;
    const prior = this.#documents.get(key) ?? null;
    const time = input.time ?? '2026-07-13T20:00:00.000Z';
    const defaultTs = isoToTimestampProto(time);
    const createTime = input.createTime ?? prior?.createTime ?? defaultTs;
    const updateTime = input.updateTime ?? defaultTs;
    this.emitMutation({
      database,
      document: normalized,
      before: prior,
      after: {
        fields: { ...input.fields },
        createTime,
        updateTime,
      },
      time,
    });
  }

  emitUpdate(input: InMemoryUpdateCommitInput): void {
    const database = input.database ?? DEFAULT_FIRESTORE_DATABASE;
    const normalized = normalizeFirestoreDocumentPath(input.document);
    const key = `${database}\u0000${normalized}`;
    const prior = this.#documents.get(key) ?? null;
    const time = input.time ?? '2026-07-13T20:00:05.000Z';
    const defaultTs = isoToTimestampProto(time);
    const createTime = prior?.createTime ?? defaultTs;
    const updateTime = input.updateTime ?? defaultTs;
    this.emitMutation({
      database,
      document: normalized,
      before: prior,
      after: {
        fields: { ...input.fields },
        createTime,
        updateTime,
      },
      time,
    });
  }

  emitDelete(input: InMemoryDeleteCommitInput): void {
    const database = input.database ?? DEFAULT_FIRESTORE_DATABASE;
    const normalized = normalizeFirestoreDocumentPath(input.document);
    const key = `${database}\u0000${normalized}`;
    const prior = this.#documents.get(key) ?? null;
    const time = input.time ?? '2026-07-13T20:00:10.000Z';
    this.emitMutation({
      database,
      document: normalized,
      before: prior,
      after: null,
      time,
    });
  }

  emitError(database: string, error: unknown): void {
    const listeners = this.#subscribers.get(database);
    if (listeners === undefined) return;
    for (const callbacks of listeners) {
      callbacks.onError?.(error);
    }
  }

  subscribe(database: string, callbacks: FirestoreDeliveryCallbacks): () => void {
    let listeners = this.#subscribers.get(database);
    if (listeners === undefined) {
      listeners = new Set();
      this.#subscribers.set(database, listeners);
    }
    listeners.add(callbacks);
    callbacks.onReady?.();
    return () => {
      const current = this.#subscribers.get(database);
      if (current === undefined) return;
      current.delete(callbacks);
      if (current.size === 0) {
        this.#subscribers.delete(database);
      }
    };
  }
}
