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
import {
  hasCollidingFirestoreMarkerShape,
  isUnescapedUserMap,
  stampUnescapedUserMap,
  stripUnescapedUserMapTag,
} from '../../firestore/sandbox/unescaped-map.js';

function isPlainSnapshotMap(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cloneFirestoreSnapshotValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneFirestoreSnapshotValue);
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof Uint8Array) return value.slice();
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) {
    const copy: Record<string, unknown> = proto === null ? Object.create(null) : {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      Object.defineProperty(copy, key, {
        value: cloneFirestoreSnapshotValue((value as Record<string, unknown>)[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return copy;
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
        return new RulesPath(record.segments as string[]);
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

function rehydrateSnapshotValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof RulesValue) return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof Uint8Array) return value.slice();
  if (Array.isArray(value)) return value.map(rehydrateSnapshotValue);
  if (!isPlainSnapshotMap(value)) return value;

  if (!isUnescapedUserMap(value)) {
    const revivedClone = reviveStructuredClonedRulesValue(value);
    if (revivedClone !== undefined) return revivedClone;
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(out, key, {
      value: rehydrateSnapshotValue(item),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  if (isUnescapedUserMap(value) || hasCollidingFirestoreMarkerShape(out)) {
    stampUnescapedUserMap(out);
  }
  return out;
}

export function snapshotFirestoreDocuments(
  rawFirestore: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const firestore: Record<string, Record<string, unknown>> = {};
  for (const [path, docData] of Object.entries(rawFirestore)) {
    Object.defineProperty(firestore, path, {
      value: cloneFirestoreSnapshotValue(docData) as Record<string, unknown>,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return firestore;
}

export function rehydrateSnapshotDocument(
  docData: Record<string, unknown>,
): Record<string, unknown> {
  return rehydrateSnapshotValue(docData) as Record<string, unknown>;
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
