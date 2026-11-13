import {
  Bytes as RulesBytes,
  Duration as RulesDuration,
  LatLng as RulesLatLng,
  Path as RulesPath,
  Reference as RulesReference,
  RulesValue,
  Timestamp as RulesTimestamp,
  Vector as RulesVector,
} from '@pyric/rules/internal';
import { rehydrateDocValue } from '../../firestore/internal/value-codec.js';
import {
  hasCollidingFirestoreMarkerShape,
  isRegisteredUnescapedUserMap,
  isUnescapedUserMap,
  registerUnescapedUserMapClone,
  stampUnescapedUserMap,
  stripUnescapedUserMapTag,
} from '../../firestore/sandbox/unescaped-map.js';

function isPlainSnapshotMap(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function clonePathBindings(raw: unknown): Record<string, string> | undefined {
  if (!isPlainSnapshotMap(raw)) return undefined;
  if (Object.keys(raw).length === 0) return undefined;
  return { ...(raw as Record<string, string>) };
}

function cloneRulesValue(value: RulesValue): RulesValue {
  if (value instanceof RulesBytes) return new RulesBytes(value.data.slice());
  if (value instanceof RulesVector) return new RulesVector(value.value.slice());
  if (value instanceof RulesPath) {
    return new RulesPath([...value.segments], clonePathBindings(value.bindings));
  }
  return value;
}

export function reviveStructuredClonedRulesValue(record: Record<string, unknown>): unknown | undefined {
  if (typeof record.typeName !== 'string') return undefined;
  switch (record.typeName) {
    case 'timestamp':
      if (typeof record.seconds === 'number' && typeof record.nanos === 'number') {
        return new RulesTimestamp(record.seconds, record.nanos);
      }
      return undefined;
    case 'bytes':
      if (record.data instanceof Uint8Array) {
        return new RulesBytes(record.data.slice());
      }
      return undefined;
    case 'latlng':
      if (typeof record.lat === 'number' && typeof record.lng === 'number') {
        return new RulesLatLng(record.lat, record.lng);
      }
      return undefined;
    case 'duration':
      if (typeof record.seconds === 'number' && typeof record.nanos === 'number') {
        return new RulesDuration(record.seconds, record.nanos);
      }
      return undefined;
    case 'reference':
      if (typeof record.path === 'string') {
        let dbId: string | undefined;
        if (typeof record.databaseId === 'string' && record.databaseId.length > 0) {
          dbId = record.databaseId;
        }
        return new RulesReference(record.path, dbId);
      }
      return undefined;
    case 'path':
      if (Array.isArray(record.segments)) {
        return new RulesPath(record.segments as string[], clonePathBindings(record.bindings));
      }
      return undefined;
    case 'vector':
      if (Array.isArray(record.value)) {
        return new RulesVector((record.value as number[]).slice());
      }
      return undefined;
    default:
      return undefined;
  }
}

function reviveJsonSnapshotMarker(record: Record<string, unknown>): unknown | undefined {
  if (record.__type__ === '__vector__' && Array.isArray(record.value)) {
    const revived = rehydrateDocValue(record);
    if (revived instanceof RulesValue) return revived;
    return undefined;
  }
  if (typeof record.__type === 'string') {
    if (record.__type === 'path' && Array.isArray(record.segments)) {
      return new RulesPath(record.segments as string[], clonePathBindings(record.bindings));
    }
    if (
      record.__type === 'timestamp' ||
      record.__type === 'bytes' ||
      record.__type === 'latlng' ||
      record.__type === 'duration' ||
      record.__type === 'reference' ||
      record.__type === 'number'
    ) {
      const revived = rehydrateDocValue(record);
      if (revived instanceof RulesValue || typeof revived === 'number') return revived;
    }
    return undefined;
  }
  if (typeof record.type === 'string' && record.type.startsWith('firestore/')) {
    const revived = rehydrateDocValue(record);
    if (revived instanceof RulesValue) return revived;
  }
  return undefined;
}

export interface SnapshotFirestoreStateResult {
  firestore: Record<string, Record<string, unknown>>;
  firestoreWrappers?: Record<string, (string | number)[][]>;
  firestoreUnescapedMaps?: Record<string, (string | number)[][]>;
}

export function snapshotFirestoreState(
  rawFirestore: Record<string, Record<string, unknown>>,
): SnapshotFirestoreStateResult {
  const firestore: Record<string, Record<string, unknown>> = {};
  const firestoreWrappers: Record<string, (string | number)[][]> = {};
  const firestoreUnescapedMaps: Record<string, (string | number)[][]> = {};
  let hasAnyWrappers = false;
  let hasAnyUnescaped = false;

  for (const [docPath, docData] of Object.entries(rawFirestore)) {
    const docWrappers: (string | number)[][] = [];
    const docUnescaped: (string | number)[][] = [];

    const cloneNode = (node: unknown, currentPath: (string | number)[]): unknown => {
      if (node === null || typeof node !== 'object') return node;
      if (node instanceof RulesValue) {
        docWrappers.push([...currentPath]);
        return cloneRulesValue(node);
      }
      if (node instanceof Date) return new Date(node.getTime());
      if (node instanceof Uint8Array) return node.slice();
      if (Array.isArray(node)) {
        return node.map((item, idx) => cloneNode(item, [...currentPath, idx]));
      }
      if (!isPlainSnapshotMap(node)) return node;
      const proto = Object.getPrototypeOf(node);
      const copy: Record<string, unknown> = proto === null ? Object.create(null) : {};
      for (const key of Object.keys(node)) {
        Object.defineProperty(copy, key, {
          value: cloneNode(node[key], [...currentPath, key]),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      if (
        isUnescapedUserMap(node) ||
        isRegisteredUnescapedUserMap(node) ||
        hasCollidingFirestoreMarkerShape(copy)
      ) {
        docUnescaped.push([...currentPath]);
        registerUnescapedUserMapClone(copy);
      }
      return copy;
    };

    Object.defineProperty(firestore, docPath, {
      value: cloneNode(docData, []) as Record<string, unknown>,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    if (docWrappers.length > 0) {
      hasAnyWrappers = true;
      Object.defineProperty(firestoreWrappers, docPath, {
        value: docWrappers,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (docUnescaped.length > 0) {
      hasAnyUnescaped = true;
      Object.defineProperty(firestoreUnescapedMaps, docPath, {
        value: docUnescaped,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }

  const result: SnapshotFirestoreStateResult = { firestore };
  if (hasAnyWrappers) result.firestoreWrappers = firestoreWrappers;
  if (hasAnyUnescaped) result.firestoreUnescapedMaps = firestoreUnescapedMaps;
  return result;
}

export function rehydrateSnapshotDocument(
  docData: Record<string, unknown>,
  wrapperPaths?: readonly (readonly (string | number)[])[],
  unescapedMapPaths?: readonly (readonly (string | number)[])[],
): Record<string, unknown> {
  const wrapperSet = new Set((wrapperPaths ?? []).map((p) => JSON.stringify(p)));
  const unescapedSet = new Set((unescapedMapPaths ?? []).map((p) => JSON.stringify(p)));

  const walk = (value: unknown, currentPath: (string | number)[]): unknown => {
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof RulesValue) return cloneRulesValue(value);
    if (value instanceof Date) return new Date(value.getTime());
    if (value instanceof Uint8Array) return value.slice();
    if (Array.isArray(value)) {
      return value.map((item, idx) => walk(item, [...currentPath, idx]));
    }
    if (!isPlainSnapshotMap(value)) return value;

    const pathKey = JSON.stringify(currentPath);
    const knownUnescaped =
      unescapedSet.has(pathKey) ||
      isUnescapedUserMap(value) ||
      isRegisteredUnescapedUserMap(value);

    if (!knownUnescaped) {
      const revivedClone = reviveStructuredClonedRulesValue(value);
      if (revivedClone !== undefined) return revivedClone;
      if (wrapperSet.has(pathKey) || (wrapperPaths === undefined && unescapedMapPaths === undefined)) {
        const revivedJson = reviveJsonSnapshotMarker(value);
        if (revivedJson !== undefined) return revivedJson;
      }
    }

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(out, key, {
        value: walk(item, [...currentPath, key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (knownUnescaped || hasCollidingFirestoreMarkerShape(out)) {
      stampUnescapedUserMap(out);
    }
    return out;
  };

  return walk(docData, []) as Record<string, unknown>;
}

export function sanitizeAdminReadDocument(
  docData: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (docData === null) return null;
  return stripUnescapedUserMapTag(docData) as Record<string, unknown>;
}

export function sanitizeAdminListedDocuments<T extends { data: Record<string, unknown> }>(
  entries: T[],
): T[] {
  return entries.map((entry) => ({
    ...entry,
    data: stripUnescapedUserMapTag(entry.data) as Record<string, unknown>,
  }));
}
