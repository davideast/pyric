/**
 * Captures pending `serverTimestamp()` field paths and prior values during a
 * local write echo so `DocumentSnapshot.data(options)` and `.get(path, options)`
 * honor `serverTimestamps: 'none' | 'estimate' | 'previous'` before settlement.
 */
import type { DocumentData } from './local-state.js';
import { translateReadData } from './admin-compat/read-translation.js';
import { isPlainObject } from '../plain-object.js';
import { registeredQueryValue } from './query-value-registry.js';
import { isUnescapedUserMap } from './unescaped-map.js';
import { fieldPathKeySegments, isFieldPathUpdate } from './update-fields.js';

export interface PendingServerTimestampEntry {
  readonly path: readonly string[];
  readonly previous: unknown;
}

const docPendingTimestamps = new WeakMap<object, readonly PendingServerTimestampEntry[]>();
const snapPendingTimestamps = new WeakMap<object, readonly PendingServerTimestampEntry[]>();

export function recordPendingServerTimestamps(
  docData: object | null | undefined,
  entries: readonly PendingServerTimestampEntry[],
): void {
  if (!docData || entries.length === 0) return;
  docPendingTimestamps.set(docData, entries);
}

export function pendingServerTimestampsFor(
  docData: object | null | undefined,
): readonly PendingServerTimestampEntry[] | undefined {
  if (!docData) return undefined;
  return docPendingTimestamps.get(docData);
}

export function recordSnapshotPendingServerTimestamps(
  snapshot: object | null | undefined,
  entries: readonly PendingServerTimestampEntry[] | undefined,
): void {
  if (!snapshot || !entries || entries.length === 0) return;
  snapPendingTimestamps.set(snapshot, entries);
}

export function snapshotPendingServerTimestamps(
  snapshot: object | null | undefined,
): readonly PendingServerTimestampEntry[] | undefined {
  if (!snapshot) return undefined;
  return snapPendingTimestamps.get(snapshot);
}

function isServerTimestampSentinel(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (isUnescapedUserMap(value)) return false;
  if (registeredQueryValue(value) !== undefined) return false;
  return (value as { __type?: unknown }).__type === 'serverTimestamp';
}

function readNestedField(source: Record<string, unknown> | undefined, path: readonly string[]): unknown {
  if (!source) return null;
  let current: unknown = source;
  for (const segment of path) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) return null;
    current = current[segment];
  }
  if (current === undefined) return null;
  return current;
}

function collectSentinelPaths(
  value: unknown,
  prefix: readonly string[],
  out: Array<readonly string[]>,
  seen: WeakSet<object>,
): void {
  if (value === null || value === undefined || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (registeredQueryValue(value) !== undefined) return;
  if (isServerTimestampSentinel(value)) {
    if (prefix.length > 0) out.push(prefix);
    return;
  }
  if (Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    collectSentinelPaths(child, [...prefix, key], out, seen);
  }
}

export function capturePendingServerTimestamps(
  operation: { method: string; data?: DocumentData; merge?: unknown },
  priorDoc: DocumentData | null,
): readonly PendingServerTimestampEntry[] {
  const data = operation.data;
  if (!data || operation.method === 'delete') return [];
  const paths: Array<readonly string[]> = [];
  const seen = new WeakSet<object>();
  if (isFieldPathUpdate(operation)) {
    for (const [encodedKey, fieldVal] of Object.entries(data)) {
      const baseSegments = fieldPathKeySegments(encodedKey);
      collectSentinelPaths(fieldVal, baseSegments, paths, seen);
    }
  } else {
    collectSentinelPaths(data, [], paths, seen);
  }
  if (paths.length === 0) return [];
  let filteredPaths = paths;
  if (typeof operation.merge === 'object' && operation.merge !== null && 'mergeFields' in operation.merge) {
    const allowedMasks = (operation.merge as { mergeFields: readonly string[] }).mergeFields.map(fieldPathKeySegments);
    filteredPaths = paths.filter((candidate) =>
      allowedMasks.some((mask) =>
        mask.length <= candidate.length && mask.every((seg, idx) => candidate[idx] === seg),
      ),
    );
  }
  if (filteredPaths.length === 0) return [];
  const preservesPriorFields = isFieldPathUpdate(operation)
    || (operation.merge !== undefined && operation.merge !== false);
  let translatedPrior: Record<string, unknown> | undefined;
  if (preservesPriorFields && priorDoc !== null) {
    translatedPrior = translateReadData(priorDoc);
  }
  return filteredPaths.map((path) => ({
    path,
    previous: readNestedField(translatedPrior, path),
  }));
}

function writeClonedField(
  root: Record<string, unknown>,
  path: readonly string[],
  replacement: unknown,
): Record<string, unknown> {
  if (path.length === 0) return root;
  const head = path[0];
  if (head === undefined) return root;
  const clone: Record<string, unknown> = { ...root };
  if (path.length === 1) {
    Object.defineProperty(clone, head, {
      value: replacement,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    return clone;
  }
  let existingChild: unknown;
  if (Object.hasOwn(clone, head)) {
    existingChild = clone[head];
  }
  let childRecord: Record<string, unknown> = {};
  if (isPlainObject(existingChild)) {
    childRecord = existingChild;
  }
  const updatedChild = writeClonedField(childRecord, path.slice(1), replacement);
  Object.defineProperty(clone, head, {
    value: updatedChild,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return clone;
}

export function projectPendingServerTimestamps(
  data: DocumentData | undefined,
  entries: readonly PendingServerTimestampEntry[] | undefined,
  mode: 'estimate' | 'previous' | 'none' | undefined,
): DocumentData | undefined {
  if (data === undefined || !entries || entries.length === 0) return data;
  if (mode === 'estimate') return data;
  let projected: Record<string, unknown> = data;
  for (const entry of entries) {
    let replacement: unknown = null;
    if (mode === 'previous') {
      replacement = entry.previous;
    }
    projected = writeClonedField(projected, entry.path, replacement);
  }
  return projected;
}
