/**
 * Firestore snapshot machinery for the worker client — wire-form document
 * results rehydrated into the modular SDK's snapshot shapes. Shared by the
 * read, listener, and transaction families.
 */
import type { SerializedDocData } from '../protocol.js';
import { deserializeDocData } from '../protocol.js';
import type { ClientPort, DocRefHandle } from './handles.js';
import { createDocumentReference } from './firestore-reference.js';
import { FirebaseError } from 'pyric/app';
import type { DocumentData, FirestoreDataConverter, QueryDocumentSnapshot, SnapshotMetadata } from 'pyric/firestore';

// ─── Rehydration (class instance restoration) ─────────────────────────────

/** Restore SDK scalar values and references bound to this snapshot's client port. */
function rehydrateDocData(serialized: SerializedDocData, port: ClientPort): Record<string, unknown> {
  const references = { create: (path: string) => createDocumentReference(port, path) };
  return deserializeDocData(serialized, references) as Record<string, unknown>;
}

// ─── Snapshot deserialization helpers ────────────────────────────────────

export interface RawDocResult {
  id: string;
  path?: string;
  exists: boolean;
  data?: SerializedDocData;
}

export function makeDocSnapshot<T = DocumentData>(raw: RawDocResult, port: ClientPort, reference?: DocRefHandle<T>): ClientDocSnapshot<T> {
  const isMalformed = !isDocumentResult(raw);
  if (isMalformed) throw new FirebaseError('invalid-argument', 'The sandbox sent a malformed document result.');
  let data: Record<string, unknown> | undefined;
  const serialized = raw.data;
  const hasData = raw.exists && serialized !== undefined;
  if (hasData) data = rehydrateDocData(serialized, port);
  const path = raw.path ?? raw.id;
  const ref = reference ?? createDocumentReference<T>(port, path);
  const metadata = { fromCache: false, hasPendingWrites: false };
  const read = (): T | undefined => {
    const document = data;
    const isMissing = document === undefined;
    if (isMissing) return undefined;
    const converter = ref.converter;
    const hasConverter = converter !== null;
    if (hasConverter) {
      const snapshot: QueryDocumentSnapshot = {
        id: raw.id,
        ref: createDocumentReference(port, path),
        exists: () => true,
        metadata,
        data: () => document,
      };
      return (converter as FirestoreDataConverter<T>).fromFirestore(snapshot);
    }
    return document as T;
  };
  return {
    id: raw.id,
    path,
    // Query snapshot refs are real worker handles, not path-only lookalikes:
    // Firebase callers may pass `snapshot.ref` straight into deleteDoc/setDoc.
    ref,
    exists: () => raw.exists,
    metadata,
    data: read,
  };
}

export interface RawQueryResult {
  docs: RawDocResult[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDocumentResult(value: unknown): value is RawDocResult {
  const isObject = isRecord(value);
  const isInvalidObject = !isObject;
  if (isInvalidObject) return false;
  const data = value.data;
  const hasValidData = data === undefined || (isRecord(data) && typeof data.json === 'string');
  const hasValidPath = value.path === undefined || typeof value.path === 'string';
  return typeof value.id === 'string' && typeof value.exists === 'boolean' && hasValidPath && hasValidData;
}

function isQueryResult(value: unknown): value is RawQueryResult {
  return isRecord(value) && Array.isArray(value.docs) && value.docs.every(isDocumentResult);
}

/** Decode a listener delivery before invoking application code. */
export function makeSnapshot(
  raw: unknown,
  port: ClientPort,
  converter: FirestoreDataConverter<unknown> | null = null,
): ClientDocSnapshot | ClientQuerySnapshot {
  const isQuery = isQueryResult(raw);
  if (isQuery) return makeQuerySnapshot(raw, port, converter);
  const isDocument = isDocumentResult(raw);
  if (isDocument) {
    return makeDocSnapshot(raw, port, createDocumentReference(port, raw.path ?? raw.id, converter));
  }
  throw new FirebaseError('invalid-argument', 'The sandbox sent a malformed Firestore snapshot.');
}

export function makeQuerySnapshot(
  raw: RawQueryResult,
  port: ClientPort,
  converter: FirestoreDataConverter<unknown> | null = null,
): ClientQuerySnapshot {
  const isMalformed = !isQueryResult(raw);
  if (isMalformed) throw new FirebaseError('invalid-argument', 'The sandbox sent a malformed query result.');
  const docs = raw.docs.map((doc) => makeDocSnapshot(
    doc,
    port,
    createDocumentReference(port, doc.path ?? doc.id, converter),
  ));
  return {
    size: docs.length,
    empty: docs.length === 0,
    docs,
  };
}

// ─── Client snapshot types ────────────────────────────────────────────────

export interface ClientDocSnapshot<T = DocumentData> {
  readonly id: string;
  readonly path: string;
  /** Full port-carrying reference, usable by write APIs. */
  readonly ref: DocRefHandle<T>;
  readonly metadata: SnapshotMetadata;
  exists(): boolean;
  data(): T | undefined;
}

export interface ClientQuerySnapshot {
  readonly size: number;
  readonly empty: boolean;
  readonly docs: ClientDocSnapshot[];
}
