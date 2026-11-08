/**
 * The live host's in-memory store of observed session data: the Firestore
 * documents and per-instance RTDB trees successful client calls saw, bounded
 * by document count and total bytes, with counts of what it skipped.
 *
 * It lives only as long as the live host process and is never written to disk
 * by itself (`wire.ts` states the contract).
 */
import { defaultDatabaseInstanceName } from 'pyric/sandbox/internal';
import { MAX_SINGLE_ITEM_BYTES } from './delta-validation.js';
import { deepMergeFirestoreMap, deleteDottedField, setDottedField } from './firestore-fields.js';
import { byteLengthOf } from './json-values.js';
import { setRtdbAtSegments } from './rtdb-tree.js';
import {
  UNREAD_RTDB_INSTANCE,
  type ObservedFirestoreSessionOp,
  type ObservedRtdbSessionOp,
  type ObservedSessionDataSnapshot,
  type ObservedSessionDelta,
  type ObservedSessionSkipStats,
} from './wire.js';

const DEFAULT_MAX_SESSION_DOCS = 2000;
const DEFAULT_MAX_SESSION_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_RTDB_INSTANCES = 32;

export interface ObservedSessionDataStoreOptions {
  readonly projectId?: string;
  readonly maxDocs?: number;
  readonly maxBytes?: number;
  readonly maxRtdbInstances?: number;
  readonly now?: () => number;
}

export interface ObservedSessionDataStore {
  apply(delta: ObservedSessionDelta, projectIdHint?: string): void;
  recordSkip(skip: Partial<ObservedSessionSkipStats>): void;
  snapshot(): ObservedSessionDataSnapshot;
}

type SkipKey = keyof ObservedSessionSkipStats;
const SKIP_KEYS: readonly SkipKey[] = ['oversized', 'unsupported', 'truncated', 'failed', 'admin'];

function segmentsOf(path: string): string[] {
  return path.split('/').filter((seg) => seg.length > 0);
}

/** Every path an RTDB op writes, as segments from the instance root. */
function writtenSegments(op: Exclude<ObservedRtdbSessionOp, { kind: 'remove' }>): string[][] {
  const base = segmentsOf(op.path);
  if (op.kind === 'set') return [base];
  return Object.keys(op.value).map((relPath) => [...base, ...segmentsOf(relPath)]);
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

  const docs = new Map<string, { data: Record<string, unknown>; bytes: number }>();
  const rtdb = new Map<string, { tree: unknown; bytes: number }>();

  const totalBytes = (): number => firestoreBytes + rtdbBytes;
  const skipTotal = (): number => SKIP_KEYS.reduce((sum, key) => sum + skips[key], 0);

  /** One item the store could not keep: `oversized` alone, or `truncated` at the session budget. */
  function drop(reason: 'oversized' | 'truncated'): void {
    truncated = true;
    droppedCount += 1;
    skips[reason] += 1;
  }

  function addSkips(skip: Partial<ObservedSessionSkipStats> | undefined): void {
    if (skip === undefined) return;
    for (const key of SKIP_KEYS) skips[key] += skip[key] ?? 0;
  }

  function resolveInstanceName(rawInstance: string): string {
    if (rawInstance !== UNREAD_RTDB_INSTANCE) return rawInstance;
    if (currentProjectId) return defaultDatabaseInstanceName(currentProjectId);
    return 'default';
  }

  function evictOldestDoc(): void {
    const oldestKey = docs.keys().next().value as string | undefined;
    if (oldestKey === undefined) return;
    const evicted = docs.get(oldestKey);
    docs.delete(oldestKey);
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
  function writeFirestoreDoc(path: string, nextData: Record<string, unknown>): boolean {
    const existing = docs.get(path);
    if (existing !== undefined) {
      docs.delete(path);
      firestoreBytes = Math.max(0, firestoreBytes - existing.bytes);
    }
    const bytes = byteLengthOf(path) + byteLengthOf(nextData);
    if (!evictFirestoreToFit(bytes)) return existing !== undefined;
    docs.set(path, { data: nextData, bytes });
    firestoreBytes += bytes;
    return true;
  }

  function deleteFieldsFrom(base: Record<string, unknown>, deleteFields: readonly string[] | undefined): void {
    for (const fieldPath of deleteFields ?? []) deleteDottedField(base, fieldPath);
  }

  function applyFirestoreOp(op: ObservedFirestoreSessionOp): boolean {
    if (op.kind === 'delete') {
      const existing = docs.get(op.path);
      if (existing === undefined) return false;
      docs.delete(op.path);
      firestoreBytes = Math.max(0, firestoreBytes - existing.bytes);
      return true;
    }
    const existing = docs.get(op.path)?.data;
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
    return writeFirestoreDoc(op.path, base);
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

  /**
   * Skips an RTDB write the store cannot keep. The paths it wrote are removed
   * as a remove would, since production's value there is no longer the one
   * the store holds, and a stale value must never show as current.
   */
  function rejectRtdbWrite(
    instance: string,
    existing: { tree: unknown; bytes: number } | undefined,
    op: Exclude<ObservedRtdbSessionOp, { kind: 'remove' }>,
    reason: 'oversized' | 'truncated',
  ): boolean {
    drop(reason);
    if (existing === undefined) return false;
    let tree = existing.tree;
    for (const segments of writtenSegments(op)) tree = setRtdbAtSegments(tree, segments, null);
    if (tree === existing.tree) return false;
    storeTree(instance, tree, existing.bytes, byteLengthOf(instance) + byteLengthOf(tree));
    return true;
  }

  /** Room for `deltaBytes` more under the shared cap, evicting the oldest documents first. */
  function makeRoomFor(deltaBytes: number): boolean {
    if (deltaBytes <= 0) return true;
    while (docs.size > 0 && totalBytes() + deltaBytes > maxBytes) evictOldestDoc();
    return totalBytes() + deltaBytes <= maxBytes;
  }

  function applyRtdbOp(op: ObservedRtdbSessionOp): boolean {
    const instance = resolveInstanceName(op.instance);
    const existing = rtdb.get(instance);
    if (existing === undefined && op.kind === 'remove') return false;
    if (existing === undefined && rtdb.size >= maxRtdbInstances) {
      drop('truncated');
      return false;
    }
    const baseTree = existing?.tree ?? null;
    let nextTree: unknown;
    if (op.kind === 'remove') {
      nextTree = setRtdbAtSegments(baseTree, segmentsOf(op.path), null);
    } else {
      if (byteLengthOf(op.value) > MAX_SINGLE_ITEM_BYTES) return rejectRtdbWrite(instance, existing, op, 'oversized');
      nextTree = baseTree;
      const values = op.kind === 'set' ? [op.value] : Object.values(op.value);
      writtenSegments(op).forEach((segments, idx) => {
        nextTree = setRtdbAtSegments(nextTree, segments, values[idx]);
      });
    }
    const previousBytes = existing?.bytes ?? 0;
    if (nextTree === null) {
      if (existing === undefined) return false;
      storeTree(instance, null, previousBytes, 0);
      return true;
    }
    const nextBytes = byteLengthOf(instance) + byteLengthOf(nextTree);
    if (op.kind !== 'remove' && !makeRoomFor(nextBytes - previousBytes)) {
      return rejectRtdbWrite(instance, existing, op, 'truncated');
    }
    storeTree(instance, nextTree, previousBytes, nextBytes);
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

  return {
    apply(delta, projectIdHint) {
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
      addSkips(delta.skipped);
      if (changed || droppedCount !== beforeDropped || skipTotal() !== beforeSkips) touch();
    },

    recordSkip(skip) {
      const before = skipTotal();
      addSkips(skip);
      if (skipTotal() !== before) touch();
    },

    snapshot(): ObservedSessionDataSnapshot {
      const firestore: Record<string, Record<string, unknown>> = {};
      for (const [path, entry] of docs) firestore[path] = structuredClone(entry.data);
      const trees: Record<string, unknown> = {};
      for (const [instance, entry] of rtdb) trees[instance] = structuredClone(entry.tree);
      const snapshot: ObservedSessionDataSnapshot = {
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
      const skipped = skipsField();
      if (skipped === undefined) return snapshot;
      return { ...snapshot, skips: skipped };
    },
  };
}
