/**
 * Builds the cached initial snapshot (`fromCache: true`) and server-synced
 * follow-up snapshot (`fromCache: false`) for `includeMetadataChanges: true`
 * listeners attached to data already warmed in this client's local cache (#1355).
 */
import { forEachDocument } from './for-each-document.js';
import {
  createDocChanges,
  type DocChangesOptions,
  type DocumentChange,
  type SnapshotMetadata,
} from './snapshot-listeners.js';
import {
  recordSnapshotPendingServerTimestamps,
  snapshotPendingServerTimestamps,
} from './pending-server-timestamps.js';

const CACHED_CLEAN_META: SnapshotMetadata = Object.freeze({
  fromCache: true,
  hasPendingWrites: false,
});

const SERVER_CLEAN_META: SnapshotMetadata = Object.freeze({
  fromCache: false,
  hasPendingWrites: false,
});

function cloneDocSnapWithMetadata(docSnap: object, metadata: SnapshotMetadata): object {
  const raw = docSnap as Record<string, unknown>;
  const cloned: Record<string, unknown> = {
    ...raw,
    metadata,
  };
  recordSnapshotPendingServerTimestamps(cloned, snapshotPendingServerTimestamps(docSnap));
  return cloned;
}

export function splitInitialMetadataSnapshots(rawSnap: unknown): {
  readonly cachedSnapshot: unknown;
  readonly serverSnapshot: unknown;
} | null {
  if (rawSnap === null || typeof rawSnap !== 'object') return null;
  const candidate = rawSnap as {
    metadata?: { hasPendingWrites?: boolean; fromCache?: boolean };
    docs?: Array<object>;
    exists?: () => boolean;
    docChanges?: (options?: DocChangesOptions) => Array<DocumentChange<object>>;
  };
  if (candidate.metadata?.hasPendingWrites === true) return null;
  if (candidate.metadata?.fromCache === true) return null;

  if (Array.isArray(candidate.docs)) {
    if (candidate.docs.length === 0) return null;
    const cachedDocs = candidate.docs.map((d) => cloneDocSnapWithMetadata(d, CACHED_CLEAN_META));
    const serverDocs = candidate.docs.map((d) => cloneDocSnapWithMetadata(d, SERVER_CLEAN_META));
    const addedChanges: DocumentChange<object>[] = cachedDocs.map((doc, idx) => ({
      type: 'added',
      doc,
      oldIndex: -1,
      newIndex: idx,
    }));
    const modifiedMetaChanges: DocumentChange<object>[] = serverDocs.map((doc, idx) => ({
      type: 'modified',
      doc,
      oldIndex: idx,
      newIndex: idx,
    }));
    const baseQuery = rawSnap as Record<string, unknown>;
    const cachedSnapshot = {
      ...baseQuery,
      metadata: CACHED_CLEAN_META,
      docs: cachedDocs,
      forEach: forEachDocument(cachedDocs),
      docChanges: createDocChanges(addedChanges, false, addedChanges),
    };
    const serverSnapshot = {
      ...baseQuery,
      metadata: SERVER_CLEAN_META,
      docs: serverDocs,
      forEach: forEachDocument(serverDocs),
      docChanges: createDocChanges([], false, modifiedMetaChanges),
    };
    return { cachedSnapshot, serverSnapshot };
  }

  if (typeof candidate.exists === 'function') {
    const cachedSnapshot = cloneDocSnapWithMetadata(rawSnap, CACHED_CLEAN_META);
    const serverSnapshot = cloneDocSnapWithMetadata(rawSnap, SERVER_CLEAN_META);
    return { cachedSnapshot, serverSnapshot };
  }

  return null;
}
