/**
 * The live host's in-memory store of observed session data: the Firestore
 * documents and per-instance RTDB trees successful client calls saw, bounded
 * by document count and total bytes, with counts of what it skipped.
 *
 * It lives only as long as the live host process and is never written to disk
 * by itself (`wire.ts` states the contract).
 */
import { normalizeDocumentPath } from 'pyric/rules/internal';
import { defaultDatabaseInstanceName, isFirestoreDocumentPath } from 'pyric/sandbox/internal';
import {
  createObservedSessionCoverage,
  type ObservedFirestoreDocLookup,
  type ObservedRtdbLookup,
} from './coverage.js';
import { MAX_SINGLE_ITEM_BYTES } from './delta-validation.js';
import { deepMergeFirestoreMap, deleteDottedField, setDottedField } from './firestore-fields.js';
import { byteLengthOf } from './json-values.js';
import { rtdbPathSegments, setRtdbAtSegments, toRtdbMockData } from './rtdb-tree.js';
import { createObservedStorageCatalog } from './storage-catalog.js';
import {
  UNREAD_RTDB_INSTANCE,
  type ObservedFirestoreSessionOp,
  type ObservedRtdbSessionOp,
  type ObservedSessionDataSnapshot,
  type ObservedSessionDelta,
  type ObservedSessionSkipStats,
  type ObservedSessionSource,
  type ObservedSessionSources,
} from './wire.js';

const DEFAULT_MAX_SESSION_DOCS = 2000;
const DEFAULT_MAX_SESSION_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_RTDB_INSTANCES = 32;

export interface ObservedSessionDataStoreOptions {
  readonly projectId?: string;
  readonly maxDocs?: number;
  readonly maxBytes?: number;
  readonly maxRtdbInstances?: number;
  readonly maxStorageObjects?: number;
  readonly maxStorageBuckets?: number;
  readonly maxStorageBytes?: number;
  readonly now?: () => number;
}

export interface ObservedSessionDataStore {
  apply(delta: ObservedSessionDelta, projectIdHint?: string, source?: ObservedSessionSource): void;
  recordSkip(skip: Partial<ObservedSessionSkipStats>): void;
  invalidateFirestore(path?: string): void;
  invalidateRtdb(instance: string | undefined, path?: string, projectIdHint?: string): void;
  snapshot(): ObservedSessionDataSnapshot;
  getFirestoreDoc(path: string): ObservedFirestoreDocLookup;
  getRtdbInstance(instance?: string): ObservedRtdbLookup;
}

type SkipKey = keyof ObservedSessionSkipStats;
type ValueRtdbOp = Extract<ObservedRtdbSessionOp, { kind: 'set' | 'update' }>;
const SKIP_KEYS: readonly SkipKey[] = ['oversized', 'unsupported', 'truncated', 'failed', 'admin'];

/** Every path an RTDB value op writes, as segments from the instance root. */
function writtenSegments(op: ValueRtdbOp): string[][] {
  const base = rtdbPathSegments(op.path);
  if (op.kind === 'set') return [base];
  return Object.keys(op.value).map((relPath) => [...base, ...rtdbPathSegments(relPath)]);
}

export function createObservedSessionDataStore(
  options: ObservedSessionDataStoreOptions = {},
): ObservedSessionDataStore {
  const maxDocs = Math.max(1, options.maxDocs ?? DEFAULT_MAX_SESSION_DOCS);
  const maxBytes = Math.max(1024, options.maxBytes ?? DEFAULT_MAX_SESSION_BYTES);
  const maxRtdbInstances = Math.max(1, options.maxRtdbInstances ?? DEFAULT_MAX_RTDB_INSTANCES);
  const now = options.now ?? Date.now;

  let currentProjectId = options.projectId ?? '';
  let revision = 0;
  let updatedAt: number | null = null;
  let truncated = false;
  let droppedCount = 0;
  let firestoreBytes = 0;
  let rtdbBytes = 0;
  const skips: Record<SkipKey, number> = { oversized: 0, unsupported: 0, truncated: 0, failed: 0, admin: 0 };
  const sources: { client: boolean; admin: boolean } = { client: false, admin: false };

  const docs = new Map<string, { data: Record<string, unknown>; bytes: number }>();
  const rtdb = new Map<string, { tree: unknown; bytes: number }>();
  const coverage = createObservedSessionCoverage({ maxDocs, maxRtdbInstances });

  const totalBytes = (): number => firestoreBytes + rtdbBytes;
  const skipTotal = (): number => SKIP_KEYS.reduce((sum, key) => sum + skips[key], 0);

  /** One item the store could not keep: `oversized` alone, or `truncated` at the session budget. */
  function drop(reason: 'oversized' | 'truncated'): void {
    truncated = true;
    droppedCount += 1;
    skips[reason] += 1;
  }

  const storageCatalog = createObservedStorageCatalog({
    maxObjects: options.maxStorageObjects,
    maxBuckets: options.maxStorageBuckets,
    maxBytes: options.maxStorageBytes ?? maxBytes,
    projectId: () => currentProjectId,
    onDrop: (reason) => {
      if (reason === 'unsupported') {
        skips.unsupported += 1;
        return;
      }
      drop(reason);
    },
  });

  function addSkips(skip: Partial<ObservedSessionSkipStats> | undefined): void {
    if (skip === undefined) return;
    for (const key of SKIP_KEYS) skips[key] += skip[key] ?? 0;
  }

  function resolveInstanceName(rawInstance: string | undefined): string {
    const hasExplicitInstance =
      rawInstance !== undefined && rawInstance !== '' && rawInstance !== UNREAD_RTDB_INSTANCE;
    if (hasExplicitInstance) {
      return rawInstance;
    }
    if (currentProjectId) return defaultDatabaseInstanceName(currentProjectId);
    return 'default';
  }

  function evictOldestDoc(): void {
    const oldestKey = docs.keys().next().value as string | undefined;
    if (oldestKey === undefined) return;
    const evicted = docs.get(oldestKey);
    docs.delete(oldestKey);
    coverage.evictFirestoreDoc(oldestKey);
    firestoreBytes = Math.max(0, firestoreBytes - (evicted?.bytes ?? 0));
    drop('truncated');
  }

  function evictFirestoreToFit(incomingBytes: number): boolean {
    if (incomingBytes > MAX_SINGLE_ITEM_BYTES || incomingBytes > maxBytes) {
      drop('oversized');
      return false;
    }
    const isOverBudget = (): boolean => docs.size >= maxDocs || totalBytes() + incomingBytes > maxBytes;
    while (docs.size > 0 && isOverBudget()) evictOldestDoc();
    if (isOverBudget()) {
      drop('truncated');
      return false;
    }
    return true;
  }

  /** Writes a document's next data; one that does not fit drops it, so no stale copy stays. */
  function writeFirestoreDoc(
    path: string,
    nextData: Record<string, unknown>,
  ): { changed: boolean; wrote: boolean } {
    const existing = docs.get(path);
    if (existing !== undefined) {
      docs.delete(path);
      firestoreBytes = Math.max(0, firestoreBytes - existing.bytes);
    }
    const bytes = byteLengthOf(path) + byteLengthOf(nextData);
    if (!evictFirestoreToFit(bytes)) return { changed: existing !== undefined, wrote: false };
    docs.set(path, { data: nextData, bytes });
    firestoreBytes += bytes;
    return { changed: true, wrote: true };
  }

  function deleteFieldsFrom(base: Record<string, unknown>, deleteFields: readonly string[] | undefined): void {
    for (const fieldPath of deleteFields ?? []) deleteDottedField(base, fieldPath);
  }

  function applyFirestoreOp(op: ObservedFirestoreSessionOp): boolean {
    const normPath = normalizeDocumentPath(op.path);
    if (op.kind === 'invalidate') {
      coverage.invalidateFirestoreDoc(normPath);
      const existing = docs.get(normPath);
      if (existing === undefined) return false;
      docs.delete(normPath);
      firestoreBytes = Math.max(0, firestoreBytes - existing.bytes);
      return true;
    }
    if (op.kind === 'delete') {
      coverage.recordFirestoreDelete(normPath);
      const existing = docs.get(normPath);
      if (existing === undefined) return false;
      docs.delete(normPath);
      firestoreBytes = Math.max(0, firestoreBytes - existing.bytes);
      return true;
    }
    const existing = docs.get(normPath)?.data;
    let base: Record<string, unknown>;
    if (op.kind === 'set') {
      const mergesExisting = op.merge === true && existing !== undefined;
      if (mergesExisting) base = deepMergeFirestoreMap(existing, op.data);
      else base = structuredClone(op.data);
    } else {
      base = structuredClone(existing ?? {});
      for (const [fieldPath, val] of Object.entries(op.data)) setDottedField(base, fieldPath, val);
    }
    deleteFieldsFrom(base, op.deleteFields);
    const outcome = writeFirestoreDoc(normPath, base);
    coverage.recordFirestoreWrite(normPath, op, outcome.wrote);
    return outcome.changed;
  }

  function storeTree(instance: string, tree: unknown, previousBytes: number, bytes: number): void {
    if (tree === null) {
      rtdb.delete(instance);
      rtdbBytes = Math.max(0, rtdbBytes - previousBytes);
      return;
    }
    rtdb.set(instance, { tree, bytes });
    rtdbBytes = Math.max(0, rtdbBytes - previousBytes + bytes);
  }

  function pruneRtdbSegments(instance: string, segmentsList: readonly (readonly string[])[]): boolean {
    coverage.invalidateRtdbSegments(instance, segmentsList);
    const existing = rtdb.get(instance);
    if (existing === undefined) return false;
    let tree = existing.tree;
    for (const segments of segmentsList) tree = setRtdbAtSegments(tree, segments, null);
    if (tree === existing.tree) return false;
    let nextBytes = 0;
    if (tree !== null) nextBytes = byteLengthOf(instance) + byteLengthOf(tree);
    storeTree(instance, tree, existing.bytes, nextBytes);
    return true;
  }

  /**
   * Skips an RTDB write the store cannot keep. The paths it wrote are removed
   * as a remove would, since production's value there is no longer the one
   * the store holds, and a stale value must never show as current.
   */
  function rejectRtdbWrite(instance: string, op: ValueRtdbOp, reason: 'oversized' | 'truncated'): boolean {
    drop(reason);
    return pruneRtdbSegments(instance, writtenSegments(op));
  }

  /** Room for `deltaBytes` more under the shared cap, evicting the oldest documents first. */
  function makeRoomFor(deltaBytes: number): boolean {
    if (deltaBytes <= 0) return true;
    while (docs.size > 0 && totalBytes() + deltaBytes > maxBytes) evictOldestDoc();
    return totalBytes() + deltaBytes <= maxBytes;
  }

  function applyRtdbOp(op: ObservedRtdbSessionOp): boolean {
    const instance = resolveInstanceName(op.instance);
    if (op.kind === 'invalidate') {
      return coverage.invalidateRtdbSegments(instance, [rtdbPathSegments(op.path)]);
    }
    const existing = rtdb.get(instance);
    if (existing === undefined && rtdb.size >= maxRtdbInstances) {
      drop('truncated');
      coverage.invalidateRtdbInstance(instance);
      return false;
    }
    if (existing === undefined && op.kind === 'remove') {
      coverage.recordRtdbCoveredSegments(instance, [rtdbPathSegments(op.path)]);
      return false;
    }
    const baseTree = existing?.tree ?? null;
    let nextTree: unknown;
    let coveredSegments: string[][];
    if (op.kind === 'remove') {
      const targetSegments = rtdbPathSegments(op.path);
      coveredSegments = [targetSegments];
      nextTree = setRtdbAtSegments(baseTree, targetSegments, null);
    } else {
      if (byteLengthOf(op.value) > MAX_SINGLE_ITEM_BYTES) return rejectRtdbWrite(instance, op, 'oversized');
      nextTree = baseTree;
      coveredSegments = writtenSegments(op);
      const values = op.kind === 'set' ? [op.value] : Object.values(op.value);
      coveredSegments.forEach((segments, idx) => {
        nextTree = setRtdbAtSegments(nextTree, segments, values[idx]);
      });
    }
    const previousBytes = existing?.bytes ?? 0;
    if (nextTree === null) {
      coverage.recordRtdbCoveredSegments(instance, coveredSegments);
      if (existing === undefined) return false;
      storeTree(instance, null, previousBytes, 0);
      return true;
    }
    const nextBytes = byteLengthOf(instance) + byteLengthOf(nextTree);
    if (op.kind !== 'remove' && !makeRoomFor(nextBytes - previousBytes)) {
      return rejectRtdbWrite(instance, op, 'truncated');
    }
    storeTree(instance, nextTree, previousBytes, nextBytes);
    coverage.recordRtdbCoveredSegments(instance, coveredSegments);
    return true;
  }

  function defaultRtdbInstanceOf(): string | null {
    if (currentProjectId) {
      const preferred = defaultDatabaseInstanceName(currentProjectId);
      if (rtdb.size === 0 || rtdb.has(preferred)) return preferred;
      if (rtdb.has(currentProjectId)) return currentProjectId;
    }
    return rtdb.keys().next().value ?? null;
  }

  function touch(): void {
    revision += 1;
    updatedAt = now();
  }

  function skipsField(): ObservedSessionSkipStats | undefined {
    if (skipTotal() === 0) return undefined;
    return { ...skips };
  }

  function sourcesField(): ObservedSessionSources | undefined {
    const hasContributingSource = sources.client || sources.admin;
    if (!hasContributingSource) return undefined;
    return { client: sources.client, admin: sources.admin };
  }

  function hasSessionOps(delta: ObservedSessionDelta): boolean {
    if (delta.firestore !== undefined && delta.firestore.length > 0) return true;
    if (delta.rtdb !== undefined && delta.rtdb.length > 0) return true;
    return delta.storage !== undefined && delta.storage.length > 0;
  }

  return {
    apply(delta, projectIdHint, source) {
      if (projectIdHint) currentProjectId = projectIdHint;
      let changed = false;
      const beforeDropped = droppedCount;
      const beforeSkips = skipTotal();
      for (const op of delta.firestore ?? []) {
        if (applyFirestoreOp(op)) changed = true;
      }
      for (const op of delta.rtdb ?? []) {
        if (applyRtdbOp(op)) changed = true;
      }
      if (storageCatalog.applyAll(delta.storage)) changed = true;
      let sourceAdded = false;
      if (source !== undefined && hasSessionOps(delta) && !sources[source]) {
        sources[source] = true;
        sourceAdded = true;
      }
      addSkips(delta.skipped);
      if (changed || sourceAdded || droppedCount !== beforeDropped || skipTotal() !== beforeSkips) touch();
    },

    recordSkip(skip) {
      const before = skipTotal();
      addSkips(skip);
      if (skipTotal() !== before) touch();
    },

    invalidateFirestore(path) {
      if (path === undefined) {
        coverage.invalidateAllFirestore();
        return;
      }
      const norm = normalizeDocumentPath(path);
      if (norm.length === 0) {
        coverage.invalidateAllFirestore();
        return;
      }
      if (isFirestoreDocumentPath(norm)) {
        coverage.invalidateFirestoreDoc(norm);
        const existing = docs.get(norm);
        if (existing === undefined) return;
        docs.delete(norm);
        firestoreBytes = Math.max(0, firestoreBytes - existing.bytes);
        touch();
        return;
      }
      coverage.invalidateFirestoreCollection(norm);
    },

    invalidateRtdb(rawInstance, path, projectIdHint) {
      if (projectIdHint) currentProjectId = projectIdHint;
      const instance = resolveInstanceName(rawInstance);
      if (path === undefined) {
        coverage.invalidateRtdbInstance(instance);
        const existing = rtdb.get(instance);
        if (existing !== undefined) {
          storeTree(instance, null, existing.bytes, 0);
          touch();
        }
        return;
      }
      if (pruneRtdbSegments(instance, [rtdbPathSegments(path)])) touch();
    },

    snapshot(): ObservedSessionDataSnapshot {
      const firestore: Record<string, Record<string, unknown>> = {};
      for (const [path, entry] of docs) firestore[path] = structuredClone(entry.data);
      const trees: Record<string, unknown> = {};
      for (const [instance, entry] of rtdb) trees[instance] = structuredClone(entry.tree);
      const base: { -readonly [K in keyof ObservedSessionDataSnapshot]: ObservedSessionDataSnapshot[K] } = {
        revision,
        updatedAt,
        projectId: currentProjectId,
        firestore,
        rtdb: trees,
        defaultRtdbInstance: defaultRtdbInstanceOf(),
        stats: {
          firestoreDocs: docs.size,
          rtdbInstances: rtdb.size,
          byteEstimate: totalBytes(),
          truncated,
          droppedCount,
        },
      };
      const recordedSources = sourcesField();
      if (recordedSources !== undefined) base.sources = recordedSources;
      const skipped = skipsField();
      if (skipped !== undefined) base.skips = skipped;
      return storageCatalog.withStorageSnapshot(base);
    },

    getFirestoreDoc(path) {
      const norm = normalizeDocumentPath(path);
      return coverage.lookupFirestoreDoc(norm, docs.get(norm)?.data);
    },

    getRtdbInstance(rawInstance) {
      const instance = resolveInstanceName(rawInstance);
      return {
        mockData: toRtdbMockData(rtdb.get(instance)?.tree),
        isPathKnown: (path) => coverage.isRtdbPathKnown(instance, path),
      };
    },
  };
}
