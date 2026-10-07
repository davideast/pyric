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
import { computeDocumentChanges, createDocChanges, type DocChangesOptions, type DocumentChange } from 'pyric/sandbox/internal';

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

const SETTLED_METADATA: SnapshotMetadata = Object.freeze({ fromCache: false, hasPendingWrites: false });
const PENDING_METADATA: SnapshotMetadata = Object.freeze({ fromCache: false, hasPendingWrites: true });

/** The snapshot frame's `hasPendingWrites` as Firestore `SnapshotMetadata`.
 * The sandbox has no offline cache, so `fromCache` is always `false`. */
function frameMetadata(raw: { hasPendingWrites?: unknown }): SnapshotMetadata {
  return raw.hasPendingWrites === true ? PENDING_METADATA : SETTLED_METADATA;
}

export function makeDocSnapshot<T = DocumentData>(
  raw: RawDocResult,
  port: ClientPort,
  reference?: DocRefHandle<T>,
  metadata: SnapshotMetadata = SETTLED_METADATA,
): ClientDocSnapshot<T> {
  const isMalformed = !isDocumentResult(raw);
  if (isMalformed) throw new FirebaseError('invalid-argument', 'The sandbox sent a malformed document result.');
  let data: Record<string, unknown> | undefined;
  const serialized = raw.data;
  const hasData = raw.exists && serialized !== undefined;
  if (hasData) data = rehydrateDocData(serialized, port);
  const path = raw.path ?? raw.id;
  const ref = reference ?? createDocumentReference<T>(port, path);
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
  /** Listener frames only: the sandbox snapshot's `metadata.hasPendingWrites`. */
  hasPendingWrites?: boolean;
}

/**
 * Per-listener state for `docChanges()`: the previous query result the
 * listener delivered, and whether it subscribed with
 * `includeMetadataChanges`. A listener passes the same state to every
 * {@link makeSnapshot} call, so each snapshot's changes are computed against
 * the one before it.
 */
export interface QueryChangeBaseline {
  readonly excludesMetadataChanges: boolean;
  previous?: RawDocResult[];
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
  converter: FirestoreDataConverter<unknown> | null,
  baseline: QueryChangeBaseline,
): ClientDocSnapshot | ClientQuerySnapshot {
  const isQuery = isQueryResult(raw);
  if (isQuery) {
    const snapshot = makeQuerySnapshot(raw, port, converter, baseline);
    baseline.previous = raw.docs;
    return snapshot;
  }
  const isDocument = isDocumentResult(raw);
  if (isDocument) {
    return makeDocSnapshot(
      raw,
      port,
      createDocumentReference(port, raw.path ?? raw.id, converter),
      frameMetadata(raw as { hasPendingWrites?: unknown }),
    );
  }
  throw new FirebaseError('invalid-argument', 'The sandbox sent a malformed Firestore snapshot.');
}

/**
 * Rehydrate a query result. A listener passes its {@link QueryChangeBaseline}
 * so `docChanges()` reports the difference from its previous snapshot; a
 * one-shot read passes none, and every document is `added`.
 */
export function makeQuerySnapshot(
  raw: RawQueryResult,
  port: ClientPort,
  converter: FirestoreDataConverter<unknown> | null = null,
  baseline: QueryChangeBaseline = { excludesMetadataChanges: false },
): ClientQuerySnapshot {
  const isMalformed = !isQueryResult(raw);
  if (isMalformed) throw new FirebaseError('invalid-argument', 'The sandbox sent a malformed query result.');
  const metadata = frameMetadata(raw);
  const snapshotOf = (doc: RawDocResult) => makeDocSnapshot(
    doc,
    port,
    createDocumentReference(port, doc.path ?? doc.id, converter),
    metadata,
  );
  const docs = raw.docs.map(snapshotOf);
  const rows = raw.docs.map((doc) => ({ path: doc.path ?? doc.id, doc }));
  const previous = baseline.previous?.map((doc) => ({ path: doc.path ?? doc.id, doc }));
  const changes = computeDocumentChanges(
    previous,
    rows,
    docs,
    (before, after) => before.doc.data?.json === after.doc.data?.json,
    (row) => snapshotOf(row.doc),
  );
  return {
    metadata,
    size: docs.length,
    empty: docs.length === 0,
    docs,
    docChanges: createDocChanges(changes, baseline.excludesMetadataChanges),
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
  readonly metadata: SnapshotMetadata;
  readonly size: number;
  readonly empty: boolean;
  readonly docs: ClientDocSnapshot[];
  /** Production's `QuerySnapshot.docChanges`: the changes since the
   * listener's previous snapshot, or every document `added` on the first. */
  docChanges(options?: DocChangesOptions): DocumentChange<ClientDocSnapshot>[];
}
