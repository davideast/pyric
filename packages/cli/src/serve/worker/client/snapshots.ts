/**
 * Firestore snapshot machinery for the worker client — wire-form document
 * results rehydrated into the modular SDK's snapshot shapes. Shared by the
 * read, listener, and transaction families.
 */
import type { SerializedDocData } from '../protocol.js';
import { deserializeDocData } from '../protocol.js';
import type { DocRefHandle } from './handles.js';

// ─── Rehydration (class instance restoration) ─────────────────────────────

/**
 * Deserialize doc data from wire form to real class instances.
 *
 * `deserializeDocData` (protocol.ts) now calls `rehydrateDocValue` from
 * pyric/sandbox, which reconstructs REAL Timestamp, Bytes, and LatLng
 * instances — not plain-object look-alikes. This means:
 *   - `snap.data().createdAt` is a real `Timestamp` with `.seconds`/`.nanos`
 *   - `snap.data().blob` is a real `Bytes` with `.data` (Uint8Array)
 *   - `snap.data().where` is a real `LatLng` with `.lat`/`.lng`
 * Consumer code that uses `instanceof` checks or method calls will work
 * correctly after deserialization.
 */
function rehydrateDocData(serialized: SerializedDocData): Record<string, unknown> {
  return deserializeDocData(serialized) as Record<string, unknown>;
}

// ─── Snapshot deserialization helpers ────────────────────────────────────

export interface RawDocResult {
  id: string;
  path?: string;
  exists: boolean;
  data?: SerializedDocData;
}

export function makeDocSnapshot(raw: RawDocResult, port: MessagePort): ClientDocSnapshot {
  const data = raw.exists && raw.data ? rehydrateDocData(raw.data) : undefined;
  const path = raw.path ?? raw.id;
  const ref: DocRefHandle = {
    __kind: 'doc-ref',
    descriptor: { __ref: 'doc', path },
    port,
    id: raw.id,
    path,
  };
  return {
    id: raw.id,
    path,
    // Query snapshot refs are real worker handles, not path-only lookalikes:
    // Firebase callers may pass `snapshot.ref` straight into deleteDoc/setDoc.
    ref,
    exists: () => raw.exists,
    data: () => data,
  };
}

export interface RawQueryResult {
  docs: RawDocResult[];
}

export function makeQuerySnapshot(raw: RawQueryResult, port: MessagePort): ClientQuerySnapshot {
  const docs = raw.docs.map((doc) => makeDocSnapshot(doc, port));
  return {
    size: docs.length,
    empty: docs.length === 0,
    docs,
  };
}

// ─── Client snapshot types ────────────────────────────────────────────────

export interface ClientDocSnapshot {
  readonly id: string;
  readonly path: string;
  /** Full port-carrying reference, usable by write APIs. */
  readonly ref: DocRefHandle;
  exists(): boolean;
  data(): Record<string, unknown> | undefined;
}

export interface ClientQuerySnapshot {
  readonly size: number;
  readonly empty: boolean;
  readonly docs: ClientDocSnapshot[];
}
