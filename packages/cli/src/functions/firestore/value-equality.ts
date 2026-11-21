/**
 * Structural Firestore value equality and DocumentMask field-path diffing
 * across raw sandbox values, Admin SDK wrappers, and wire-encoded markers.
 */

type ComparableScalar =
  | { readonly kind: 'timestamp'; readonly seconds: number; readonly nanoseconds: number }
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array }
  | { readonly kind: 'geopoint'; readonly latitude: number; readonly longitude: number }
  | { readonly kind: 'reference'; readonly databaseId: string; readonly path: string }
  | { readonly kind: 'vector'; readonly values: readonly number[] }
  | { readonly kind: 'special-number'; readonly token: string };

const SIMPLE_FIELD_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isEscapedUserMap(record: Record<string, unknown>): record is {
  readonly type: 'pyric/map/1.0';
  readonly fields: Record<string, unknown>;
} {
  const keys = Object.keys(record);
  if (keys.length !== 2) return false;
  if (!Object.hasOwn(record, 'type') || record.type !== 'pyric/map/1.0') return false;
  if (!Object.hasOwn(record, 'fields')) return false;
  return isPlainObject(record.fields);
}

function decodeBase64StdBytes(encoded: string): Uint8Array {
  const clean = encoded.replace(/\s+/g, '');
  const padLen = (4 - (clean.length % 4)) % 4;
  const padded = clean + '='.repeat(padLen);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let idx = 0; idx < binary.length; idx += 1) {
    out[idx] = binary.charCodeAt(idx);
  }
  return out;
}

function decodeBase64UrlBytes(encoded: string): Uint8Array {
  const std = encoded.replace(/-/g, '+').replace(/_/g, '/');
  return decodeBase64StdBytes(std);
}

function normalizeRefPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

function extractVersionedSdkMarkerScalar(
  record: Record<string, unknown>,
): ComparableScalar | null {
  const versionedType = record.type;
  if (versionedType === 'firestore/timestamp/1.0') {
    if (
      Object.keys(record).length === 3 &&
      Object.hasOwn(record, 'seconds') &&
      Object.hasOwn(record, 'nanoseconds') &&
      typeof record.seconds === 'number' &&
      typeof record.nanoseconds === 'number'
    ) {
      return {
        kind: 'timestamp',
        seconds: record.seconds,
        nanoseconds: record.nanoseconds,
      };
    }
    return null;
  }
  if (versionedType === 'firestore/bytes/1.0' && typeof record.bytes === 'string') {
    return { kind: 'bytes', bytes: decodeBase64StdBytes(record.bytes) };
  }
  if (
    versionedType === 'firestore/geoPoint/1.0' &&
    typeof record.latitude === 'number' &&
    typeof record.longitude === 'number'
  ) {
    return { kind: 'geopoint', latitude: record.latitude, longitude: record.longitude };
  }
  if (versionedType === 'firestore/vectorValue/1.0' && Array.isArray(record.vectorValues)) {
    const numeric = record.vectorValues.every((entry) => typeof entry === 'number');
    if (numeric) {
      return { kind: 'vector', values: record.vectorValues as number[] };
    }
  }
  return null;
}

function extractEncodedMarkerScalar(record: Record<string, unknown>): ComparableScalar | null {
  if (record.__type__ === '__vector__' && Array.isArray(record.value)) {
    const numeric = record.value.every((entry) => typeof entry === 'number');
    if (numeric) {
      return { kind: 'vector', values: record.value as number[] };
    }
  }
  if (Object.hasOwn(record, 'type') && typeof record.type === 'string') {
    const versioned = extractVersionedSdkMarkerScalar(record);
    if (versioned !== null) return versioned;
  }
  if (!Object.hasOwn(record, '__type') || typeof record.__type !== 'string') {
    return null;
  }
  const tag = record.__type;
  if (tag === 'timestamp' && Object.keys(record).length === 3 && typeof record.seconds === 'number') {
    let nanoseconds: number | undefined;
    if (Object.hasOwn(record, 'nanoseconds') && typeof record.nanoseconds === 'number') {
      nanoseconds = record.nanoseconds;
    } else if (Object.hasOwn(record, 'nanos') && typeof record.nanos === 'number') {
      nanoseconds = record.nanos;
    }
    if (nanoseconds !== undefined) {
      return { kind: 'timestamp', seconds: record.seconds, nanoseconds };
    }
  }
  if (tag === 'bytes' && typeof record.base64 === 'string') {
    return { kind: 'bytes', bytes: decodeBase64UrlBytes(record.base64) };
  }
  if (tag === 'bytes' && typeof record.value === 'string') {
    return { kind: 'bytes', bytes: decodeBase64StdBytes(record.value) };
  }
  if (
    (tag === 'geopoint' || tag === 'latlng') &&
    typeof record.latitude === 'number' &&
    typeof record.longitude === 'number'
  ) {
    return { kind: 'geopoint', latitude: record.latitude, longitude: record.longitude };
  }
  if (tag === 'latlng' && typeof record.lat === 'number' && typeof record.lng === 'number') {
    return { kind: 'geopoint', latitude: record.lat, longitude: record.lng };
  }
  if (tag === 'reference' && typeof record.path === 'string') {
    let databaseId = '(default)';
    if (typeof record.databaseId === 'string' && record.databaseId.length > 0) {
      databaseId = record.databaseId;
    }
    return { kind: 'reference', databaseId, path: normalizeRefPath(record.path) };
  }
  if (tag === 'vector' && Array.isArray(record.values)) {
    const numeric = record.values.every((entry) => typeof entry === 'number');
    if (numeric) {
      return { kind: 'vector', values: record.values as number[] };
    }
  }
  if (tag === 'number' && typeof record.value === 'string') {
    return { kind: 'special-number', token: record.value };
  }
  return null;
}

function unwrapPlainMap(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null;
  if (isEscapedUserMap(value)) {
    return value.fields;
  }
  if (extractEncodedMarkerScalar(value) !== null) {
    return null;
  }
  return value;
}

function extractScalar(value: unknown): ComparableScalar | null {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { kind: 'special-number', token: 'NaN' };
    if (value === Infinity) return { kind: 'special-number', token: 'Infinity' };
    if (value === -Infinity) return { kind: 'special-number', token: '-Infinity' };
    if (Object.is(value, -0)) return { kind: 'special-number', token: '-0' };
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  if (value instanceof Uint8Array) {
    return { kind: 'bytes', bytes: value };
  }
  if (value instanceof Date) {
    const millis = value.getTime();
    const seconds = Math.floor(millis / 1_000);
    const nanoseconds = (millis - seconds * 1_000) * 1_000_000;
    return { kind: 'timestamp', seconds, nanoseconds };
  }
  if (isPlainObject(value)) {
    if (isEscapedUserMap(value)) return null;
    return extractEncodedMarkerScalar(value);
  }
  const candidate = value as Record<string, unknown> & {
    toUint8Array?: () => Uint8Array;
    toArray?: () => number[];
  };
  if (typeof candidate.seconds === 'number') {
    let nanoseconds: number | undefined;
    if (typeof candidate.nanoseconds === 'number') {
      nanoseconds = candidate.nanoseconds;
    } else if (typeof candidate.nanos === 'number') {
      nanoseconds = candidate.nanos;
    }
    if (nanoseconds !== undefined) {
      return { kind: 'timestamp', seconds: candidate.seconds, nanoseconds };
    }
  }
  if (candidate.data instanceof Uint8Array) {
    return { kind: 'bytes', bytes: candidate.data };
  }
  if (typeof candidate.toUint8Array === 'function') {
    return { kind: 'bytes', bytes: candidate.toUint8Array() };
  }
  if (typeof candidate.latitude === 'number' && typeof candidate.longitude === 'number') {
    return { kind: 'geopoint', latitude: candidate.latitude, longitude: candidate.longitude };
  }
  if (typeof candidate.lat === 'number' && typeof candidate.lng === 'number') {
    return { kind: 'geopoint', latitude: candidate.lat, longitude: candidate.lng };
  }
  if (typeof candidate.path === 'string') {
    let databaseId = '(default)';
    if (typeof candidate.databaseId === 'string' && candidate.databaseId.length > 0) {
      databaseId = candidate.databaseId;
    }
    return { kind: 'reference', databaseId, path: normalizeRefPath(candidate.path) };
  }
  if (candidate.typeName === 'vector' && Array.isArray(candidate.value)) {
    return { kind: 'vector', values: candidate.value as number[] };
  }
  if (typeof candidate.toArray === 'function') {
    return { kind: 'vector', values: candidate.toArray() };
  }
  return null;
}

function scalarsEqual(left: ComparableScalar, right: ComparableScalar): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'timestamp':
      return (
        right.kind === 'timestamp' &&
        left.seconds === right.seconds &&
        left.nanoseconds === right.nanoseconds
      );
    case 'bytes': {
      if (right.kind !== 'bytes' || left.bytes.byteLength !== right.bytes.byteLength) {
        return false;
      }
      for (let idx = 0; idx < left.bytes.byteLength; idx += 1) {
        if (left.bytes[idx] !== right.bytes[idx]) return false;
      }
      return true;
    }
    case 'geopoint':
      return (
        right.kind === 'geopoint' &&
        Object.is(left.latitude, right.latitude) &&
        Object.is(left.longitude, right.longitude)
      );
    case 'reference':
      return (
        right.kind === 'reference' &&
        left.databaseId === right.databaseId &&
        left.path === right.path
      );
    case 'vector': {
      if (right.kind !== 'vector' || left.values.length !== right.values.length) {
        return false;
      }
      for (let idx = 0; idx < left.values.length; idx += 1) {
        if (!Object.is(left.values[idx], right.values[idx])) return false;
      }
      return true;
    }
    case 'special-number':
      return right.kind === 'special-number' && left.token === right.token;
  }
}

/** Structural Firestore value equality across raw, Admin, and wire-encoded values. */
export function areFirestoreValuesEqual(left: unknown, right: unknown): boolean {
  const leftScalar = extractScalar(left);
  const rightScalar = extractScalar(right);
  if (leftScalar !== null || rightScalar !== null) {
    if (leftScalar === null || rightScalar === null) return false;
    return scalarsEqual(leftScalar, rightScalar);
  }
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    for (let idx = 0; idx < left.length; idx += 1) {
      if (!areFirestoreValuesEqual(left[idx], right[idx])) return false;
    }
    return true;
  }
  const leftMap = unwrapPlainMap(left);
  const rightMap = unwrapPlainMap(right);
  if (leftMap === null || rightMap === null) return false;
  const leftKeys = Object.keys(leftMap);
  const rightKeys = Object.keys(rightMap);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.hasOwn(rightMap, key)) return false;
    if (!areFirestoreValuesEqual(leftMap[key], rightMap[key])) return false;
  }
  return true;
}

/** Whether two Firestore document field maps have identical stored state. */
export function areFirestoreDocumentsEqual(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): boolean {
  if (before === null && after === null) return true;
  if (before === null || after === null) return false;
  return areFirestoreValuesEqual(before, after);
}

/** Escape one Firestore field-path segment per DocumentMask proto conventions. */
export function formatFieldMaskSegment(segment: string): string {
  if (SIMPLE_FIELD_SEGMENT.test(segment)) {
    return segment;
  }
  const escaped = segment.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
  return `\`${escaped}\``;
}

function collectChangedFieldPaths(
  beforeMap: Record<string, unknown>,
  afterMap: Record<string, unknown>,
  prefix: readonly string[],
  out: string[],
): void {
  const keySet = new Set<string>([...Object.keys(beforeMap), ...Object.keys(afterMap)]);
  for (const key of keySet) {
    const hasBefore = Object.hasOwn(beforeMap, key);
    const hasAfter = Object.hasOwn(afterMap, key);
    const pathSegments = [...prefix, formatFieldMaskSegment(key)];
    if (!hasBefore || !hasAfter) {
      out.push(pathSegments.join('.'));
      continue;
    }
    const beforeVal = beforeMap[key];
    const afterVal = afterMap[key];
    if (areFirestoreValuesEqual(beforeVal, afterVal)) {
      continue;
    }
    const nestedBefore = unwrapPlainMap(beforeVal);
    const nestedAfter = unwrapPlainMap(afterVal);
    if (nestedBefore !== null && nestedAfter !== null) {
      const beforeEmpty = Object.keys(nestedBefore).length === 0;
      const afterEmpty = Object.keys(nestedAfter).length === 0;
      if ((!beforeEmpty && !afterEmpty) || (beforeEmpty && !afterEmpty)) {
        collectChangedFieldPaths(nestedBefore, nestedAfter, pathSegments, out);
        continue;
      }
    }
    out.push(pathSegments.join('.'));
  }
}

/** Compute sorted DocumentMask field_paths for an update from `before` to `after`. */
export function computeDocumentUpdateMask(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const unwrappedBefore = unwrapPlainMap(before) ?? before;
  const unwrappedAfter = unwrapPlainMap(after) ?? after;
  const paths: string[] = [];
  collectChangedFieldPaths(unwrappedBefore, unwrappedAfter, [], paths);
  paths.sort();
  return paths;
}
