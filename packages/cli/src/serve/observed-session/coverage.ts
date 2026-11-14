/**
 * Authoritative-vs-partial coverage tracking for `ObservedSessionDataStore`.
 *
 * A live host's session store materializes intermediate RTDB ancestor objects
 * (`setRtdbAtSegments`) when recording a deep child write and deletes Firestore
 * map entries on `delete` ops (both explicit deletes and non-existent `getDoc`
 * misses). Without tracking which Firestore documents and RTDB subtrees were
 * observed in full, a local rules simulation could treat an unobserved sibling
 * or omitted field as absent and fail open.
 */
import { normalizeDocumentPath } from 'pyric/rules/internal';
import { canonicalRtdbPath } from './rtdb-tree.js';
import type { ObservedFirestoreSessionOp } from './wire.js';

const MAX_COVERED_SUBTREES_PER_INSTANCE = 2048;

export type ObservedFirestoreDocLookup =
  | { readonly status: 'complete'; readonly data: Record<string, unknown> }
  | { readonly status: 'absent' }
  | { readonly status: 'partial'; readonly data: Record<string, unknown> }
  | { readonly status: 'unobserved' };

export interface ObservedRtdbLookup {
  readonly mockData: Record<string, unknown>;
  isPathKnown(path: string): boolean;
}

function isRtdbPrefixOrSame(prefix: string, target: string): boolean {
  if (prefix === '/') return true;
  return target === prefix || target.startsWith(`${prefix}/`);
}

function isDirectChildOfCollection(docPath: string, collectionPath: string): boolean {
  const prefix = `${collectionPath}/`;
  if (!docPath.startsWith(prefix)) return false;
  return !docPath.slice(prefix.length).includes('/');
}

export function matchesCollectionScope(docPath: string, collectionPath: string): boolean {
  if (isDirectChildOfCollection(docPath, collectionPath)) return true;
  if (collectionPath.includes('/')) return false;
  const segments = docPath.split('/');
  return segments.length >= 2 && segments[segments.length - 2] === collectionPath;
}

export interface ObservedSessionCoverage {
  recordFirestoreDelete(path: string): void;
  recordFirestoreWrite(
    path: string,
    op: Exclude<ObservedFirestoreSessionOp, { kind: 'delete' | 'invalidate' }>,
    wrote: boolean,
  ): void;
  evictFirestoreDoc(path: string): void;
  invalidateFirestoreDoc(path: string): void;
  invalidateFirestoreCollection(collectionPath: string): void;
  invalidateAllFirestore(): void;
  lookupFirestoreDoc(
    path: string,
    storedData: Record<string, unknown> | undefined,
  ): ObservedFirestoreDocLookup;
  recordRtdbCoveredSegments(instance: string, segmentsList: readonly (readonly string[])[]): void;
  invalidateRtdbSegments(instance: string, segmentsList: readonly (readonly string[])[]): boolean;
  invalidateRtdbInstance(instance: string): void;
  isRtdbPathKnown(instance: string, path: string): boolean;
}

export function createObservedSessionCoverage(options: {
  readonly maxDocs: number;
  readonly maxRtdbInstances: number;
}): ObservedSessionCoverage {
  const { maxDocs, maxRtdbInstances } = options;
  const docState = new Map<string, 'complete' | 'partial'>();
  const absentDocs = new Set<string>();
  const rtdbSubtrees = new Map<string, Set<string>>();

  function ensureRtdbSet(instance: string): Set<string> {
    const existing = rtdbSubtrees.get(instance);
    if (existing !== undefined) return existing;
    if (rtdbSubtrees.size >= maxRtdbInstances) {
      const oldestInstance = rtdbSubtrees.keys().next().value as string | undefined;
      if (oldestInstance !== undefined) rtdbSubtrees.delete(oldestInstance);
    }
    const created = new Set<string>();
    rtdbSubtrees.set(instance, created);
    return created;
  }

  return {
    recordFirestoreDelete(path) {
      const norm = normalizeDocumentPath(path);
      docState.delete(norm);
      absentDocs.delete(norm);
      while (absentDocs.size >= maxDocs) {
        const oldest = absentDocs.values().next().value as string | undefined;
        if (oldest === undefined) break;
        absentDocs.delete(oldest);
      }
      absentDocs.add(norm);
    },

    recordFirestoreWrite(path, op, wrote) {
      const norm = normalizeDocumentPath(path);
      if (!wrote) {
        docState.delete(norm);
        absentDocs.delete(norm);
        return;
      }
      const priorWasComplete = docState.get(norm) === 'complete';
      const priorWasAbsent = absentDocs.has(norm);
      absentDocs.delete(norm);
      const isUnmergedSet = op.kind === 'set' && op.merge !== true;
      const isMergeOntoKnown = op.kind === 'set' && op.merge === true && (priorWasComplete || priorWasAbsent);
      const isUpdateOntoKnown =
        op.kind === 'update' && (priorWasComplete || (op.merge === true && priorWasAbsent));
      const isComplete = op.partial !== true && (isUnmergedSet || isMergeOntoKnown || isUpdateOntoKnown);
      docState.set(norm, isComplete ? 'complete' : 'partial');
    },

    evictFirestoreDoc(path) {
      docState.delete(normalizeDocumentPath(path));
    },

    invalidateFirestoreDoc(path) {
      const norm = normalizeDocumentPath(path);
      docState.delete(norm);
      absentDocs.delete(norm);
    },

    invalidateFirestoreCollection(collectionPath) {
      const norm = normalizeDocumentPath(collectionPath);
      for (const entry of [...docState.keys()]) {
        if (matchesCollectionScope(entry, norm)) docState.delete(entry);
      }
      for (const entry of [...absentDocs]) {
        if (matchesCollectionScope(entry, norm)) absentDocs.delete(entry);
      }
    },

    invalidateAllFirestore() {
      docState.clear();
      absentDocs.clear();
    },

    lookupFirestoreDoc(path, storedData) {
      const norm = normalizeDocumentPath(path);
      const status = docState.get(norm);
      if (storedData !== undefined && status !== undefined) {
        return { status, data: structuredClone(storedData) };
      }
      if (absentDocs.has(norm)) return { status: 'absent' };
      return { status: 'unobserved' };
    },

    recordRtdbCoveredSegments(instance, segmentsList) {
      const set = ensureRtdbSet(instance);
      for (const segments of segmentsList) {
        const prefix = canonicalRtdbPath(segments);
        let alreadyCovered = false;
        for (const existing of set) {
          if (isRtdbPrefixOrSame(existing, prefix)) {
            alreadyCovered = true;
            break;
          }
        }
        if (alreadyCovered) continue;
        for (const existing of [...set]) {
          if (isRtdbPrefixOrSame(prefix, existing)) set.delete(existing);
        }
        while (set.size >= MAX_COVERED_SUBTREES_PER_INSTANCE) {
          const oldest = set.values().next().value as string | undefined;
          if (oldest === undefined) break;
          set.delete(oldest);
        }
        set.add(prefix);
      }
    },

    invalidateRtdbSegments(instance, segmentsList) {
      const set = rtdbSubtrees.get(instance);
      if (set === undefined) return false;
      let removed = false;
      for (const segments of segmentsList) {
        const target = canonicalRtdbPath(segments);
        for (const existing of [...set]) {
          const overlaps = isRtdbPrefixOrSame(existing, target) || isRtdbPrefixOrSame(target, existing);
          if (overlaps && set.delete(existing)) removed = true;
        }
      }
      if (set.size === 0) rtdbSubtrees.delete(instance);
      return removed;
    },

    invalidateRtdbInstance(instance) {
      rtdbSubtrees.delete(instance);
    },

    isRtdbPathKnown(instance, path) {
      const set = rtdbSubtrees.get(instance);
      if (set === undefined) return false;
      const target = canonicalRtdbPath(path);
      for (const prefix of set) {
        if (isRtdbPrefixOrSame(prefix, target)) return true;
      }
      return false;
    },
  };
}
