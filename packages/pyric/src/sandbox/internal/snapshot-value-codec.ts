/**
 * Browser-clean, lossless value and binary codecs for `SandboxSnapshot`.
 *
 * Runs identically in Node/Bun and browser/SharedWorker environments without
 * `node:*` modules or `Buffer`.
 */
import {
  Bytes as SdkBytes,
  GeoPoint as SdkGeoPoint,
  Timestamp as SdkTimestamp,
  VectorValue as SdkVectorValue,
} from '../../firestore/index.js';
import {
  DOC_VALUE_ENCODING,
  decodeDocValue,
  registeredReferenceQueryValuePath,
  rehydrateEncodedDocValue,
  requireDocumentData,
  type ReferenceDecoder,
} from '../../firestore/internal/value-codec.js';
import {
  Bytes as RulesBytes,
  LatLng as RulesLatLng,
  Reference as RulesReference,
  Timestamp as RulesTimestamp,
  Vector as RulesVector,
} from '../../rules/internal/index.js';

export type EncodedMap = Readonly<Record<string, unknown>>;

export type { ReferenceDecoder };

const BASE64_CHUNK_BYTES = 8192;
const DEFAULT_DB_ID = '(default)';

/** Encode a `Uint8Array` into standard RFC 4648 base64 without `Buffer`. */
export function encodeBytesToBase64(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) return '';
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += BASE64_CHUNK_BYTES) {
    const end = Math.min(offset + BASE64_CHUNK_BYTES, bytes.byteLength);
    const codes: number[] = [];
    for (let index = offset; index < end; index++) {
      codes.push(bytes[index]!);
    }
    chunks.push(String.fromCharCode(...codes));
  }
  return btoa(chunks.join(''));
}

/** Decode standard RFC 4648 base64 into a `Uint8Array` without `Buffer`. */
export function decodeBase64ToBytes(base64: string): Uint8Array {
  if (base64.length === 0) return new Uint8Array(0);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function ownField(record: Readonly<Record<string, unknown>>, key: string): unknown {
  if (!Object.hasOwn(record, key)) return undefined;
  return record[key];
}

function defineOwnProperty(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

const RESOURCE_DOCUMENTS_PREFIX = /^(?:projects\/[^/]+\/)?databases\/([^/]+)\/documents(?:\/|$)/;

function normalizeRelativeRefPath(rawPath: string): string {
  const trimmed = rawPath.replace(/^\/+|\/+$/g, '');
  const match = RESOURCE_DOCUMENTS_PREFIX.exec(trimmed);
  return match ? trimmed.slice(match[0].length).replace(/^\/+/, '') : trimmed;
}

function extractRefDatabaseId(rawPath: string): string {
  const trimmed = rawPath.replace(/^\/+|\/+$/g, '');
  const match = RESOURCE_DOCUMENTS_PREFIX.exec(trimmed);
  if (match !== null) return match[1]!;
  return DEFAULT_DB_ID;
}

interface DuckDocumentReference {
  readonly path: string;
  readonly id: string;
  readonly firestore?: unknown;
  readonly _firestore?: unknown;
}

function extractDocumentReference(
  value: object,
): { readonly path: string; readonly databaseId: string } | undefined {
  if (value instanceof RulesReference) {
    return { path: value.path, databaseId: value.databaseId };
  }
  const registered = registeredReferenceQueryValuePath(value);
  if (registered !== undefined) {
    return {
      path: normalizeRelativeRefPath(registered),
      databaseId: extractRefDatabaseId(registered),
    };
  }

  const candidate = value as Partial<DuckDocumentReference> & { readonly type?: unknown };
  const hasPathAndId = typeof candidate.path === 'string' && typeof candidate.id === 'string';
  if (!hasPathAndId) return undefined;
  const hasFirestoreOwner =
    candidate.firestore !== undefined ||
    candidate._firestore !== undefined ||
    candidate.type === 'document';
  if (!hasFirestoreOwner) return undefined;
  return {
    path: normalizeRelativeRefPath(candidate.path),
    databaseId: extractRefDatabaseId(candidate.path),
  };
}

function encodeSerializableToJsonMarker(value: object): Record<string, unknown> | undefined {
  const maybeJson = value as { toJSON?: () => unknown };
  if (typeof maybeJson.toJSON !== 'function') return undefined;
  const serialized = maybeJson.toJSON();
  if (serialized === null || typeof serialized !== 'object' || Array.isArray(serialized)) {
    return undefined;
  }
  const record = serialized as Record<string, unknown>;
  const tagType = ownField(record, 'type');
  if (
    tagType === 'firestore/timestamp/1.0' ||
    tagType === 'firestore/bytes/1.0' ||
    tagType === 'firestore/geoPoint/1.0' ||
    tagType === 'firestore/vectorValue/1.0'
  ) {
    return { ...record };
  }
  const dunderType = ownField(record, '__type');
  const seconds = ownField(record, 'seconds');
  if (dunderType === 'timestamp' && typeof seconds === 'number') {
    let nanoseconds = 0;
    const nanos = ownField(record, 'nanos');
    if (typeof nanos === 'number') {
      nanoseconds = nanos;
    }
    return {
      type: 'firestore/timestamp/1.0',
      seconds,
      nanoseconds,
    };
  }
  const base64 = ownField(record, 'base64');
  if (dunderType === 'bytes' && typeof base64 === 'string') {
    const standard = base64.replace(/-/g, '+').replace(/_/g, '/');
    const remainder = standard.length % 4;
    let padded = standard;
    if (remainder > 0) {
      padded = standard + '='.repeat(4 - remainder);
    }
    return {
      type: 'firestore/bytes/1.0',
      bytes: padded,
    };
  }
  const lat = ownField(record, 'lat');
  const lng = ownField(record, 'lng');
  if (dunderType === 'latlng' && typeof lat === 'number' && typeof lng === 'number') {
    return {
      type: 'firestore/geoPoint/1.0',
      latitude: lat,
      longitude: lng,
    };
  }
  const refPath = ownField(record, 'path');
  if (dunderType === 'reference' && typeof refPath === 'string') {
    const relPath = normalizeRelativeRefPath(refPath);
    let databaseId = extractRefDatabaseId(refPath);
    const explicitDb = ownField(record, 'databaseId');
    if (typeof explicitDb === 'string' && explicitDb.length > 0) {
      databaseId = explicitDb;
    }
    if (databaseId !== DEFAULT_DB_ID) {
      return { __type: 'reference', path: relPath, databaseId };
    }
    return { __type: 'reference', path: relPath };
  }
  const vectorRaw = ownField(record, 'value');
  if (ownField(record, '__type__') === '__vector__' && Array.isArray(vectorRaw)) {
    return {
      type: 'firestore/vectorValue/1.0',
      vectorValues: [...vectorRaw],
    };
  }
  return undefined;
}

/** Encode a single Firestore value into a JSON-safe canonical value or marker. */
export function encodeSnapshotValue(value: unknown): unknown {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { type: 'pyric/number/1.0', value: 'NaN' };
    if (value === Number.POSITIVE_INFINITY) return { type: 'pyric/number/1.0', value: 'Infinity' };
    if (value === Number.NEGATIVE_INFINITY) return { type: 'pyric/number/1.0', value: '-Infinity' };
    if (Object.is(value, -0)) return { type: 'pyric/number/1.0', value: '-0' };
    return value;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (value instanceof SdkTimestamp) {
    return {
      type: 'firestore/timestamp/1.0',
      seconds: value.seconds,
      nanoseconds: value.nanoseconds,
    };
  }
  if (value instanceof RulesTimestamp) {
    return {
      type: 'firestore/timestamp/1.0',
      seconds: value.seconds,
      nanoseconds: value.nanos,
    };
  }
  if (value instanceof Date) {
    const ts = SdkTimestamp.fromDate(value);
    return {
      type: 'firestore/timestamp/1.0',
      seconds: ts.seconds,
      nanoseconds: ts.nanoseconds,
    };
  }
  if (value instanceof SdkBytes) {
    return {
      type: 'firestore/bytes/1.0',
      bytes: encodeBytesToBase64(value.toUint8Array()),
    };
  }
  if (value instanceof RulesBytes) {
    return {
      type: 'firestore/bytes/1.0',
      bytes: encodeBytesToBase64(value.data),
    };
  }
  if (value instanceof Uint8Array) {
    return {
      type: 'firestore/bytes/1.0',
      bytes: encodeBytesToBase64(value),
    };
  }
  if (value instanceof SdkGeoPoint) {
    return {
      type: 'firestore/geoPoint/1.0',
      latitude: value.latitude,
      longitude: value.longitude,
    };
  }
  if (value instanceof RulesLatLng) {
    return {
      type: 'firestore/geoPoint/1.0',
      latitude: value.lat,
      longitude: value.lng,
    };
  }
  if (value instanceof SdkVectorValue) {
    return {
      type: 'firestore/vectorValue/1.0',
      vectorValues: value.toArray(),
    };
  }
  if (value instanceof RulesVector) {
    return {
      type: 'firestore/vectorValue/1.0',
      vectorValues: [...value.value],
    };
  }

  const docRef = extractDocumentReference(value);
  if (docRef !== undefined) {
    if (docRef.databaseId !== DEFAULT_DB_ID) {
      return { __type: 'reference', path: docRef.path, databaseId: docRef.databaseId };
    }
    return { __type: 'reference', path: docRef.path };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => encodeSnapshotValue(entry));
  }

  const prototype = Object.getPrototypeOf(value);
  const isPlainObject = prototype === Object.prototype || prototype === null;
  if (!isPlainObject) {
    const marker = encodeSerializableToJsonMarker(value);
    if (marker !== undefined) return marker;
  }

  const fields: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === undefined) continue;
    defineOwnProperty(fields, key, encodeSnapshotValue(entry));
  }
  const hasMarkerKey =
    Object.hasOwn(fields, 'type') ||
    Object.hasOwn(fields, '__type') ||
    Object.hasOwn(fields, '__type__');
  if (hasMarkerKey) {
    return { type: 'pyric/map/1.0', fields };
  }
  return fields;
}

function isEscapedMapEnvelope(
  record: Readonly<Record<string, unknown>>,
): record is { readonly type: 'pyric/map/1.0'; readonly fields: Readonly<Record<string, unknown>> } {
  const innerFields = ownField(record, 'fields');
  if (innerFields === null || typeof innerFields !== 'object' || Array.isArray(innerFields)) {
    return false;
  }
  const proto = Object.getPrototypeOf(innerFields);
  return (
    (proto === Object.prototype || proto === null) &&
    Object.keys(record).length === 2 &&
    ownField(record, 'type') === 'pyric/map/1.0'
  );
}

/** Encode a Firestore document map into a pure JSON-safe `EncodedMap`. */
export function encodeSnapshotMap(map: Readonly<Record<string, unknown>>): EncodedMap {
  const encoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(map)) {
    if (value === undefined) continue;
    defineOwnProperty(encoded, key, encodeSnapshotValue(value));
  }
  if (isEscapedMapEnvelope(encoded)) {
    return { type: 'pyric/map/1.0', fields: encoded };
  }
  return encoded;
}

type DecodeTargetMode = 'sdk' | 'env';

/**
 * Sanitize hand-authored maps whose `type` or `__type` key looks like a marker
 * name without valid marker payload fields, so plain hand-authored `SandboxSeed`
 * documents pass through cleanly alongside `EncodedMap` documents.
 */
function guardMalformedHandAuthoredMarkers(value: unknown, mode: DecodeTargetMode): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => guardMalformedHandAuthoredMarkers(item, mode));
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    const encodedLive = encodeSnapshotValue(value);
    return guardMalformedHandAuthoredMarkers(encodedLive, mode);
  }
  const record = value as Record<string, unknown>;
  const tagType = ownField(record, 'type');
  const dunderType = ownField(record, '__type');
  const dunderVectorType = ownField(record, '__type__');

  if (tagType === 'pyric/number/1.0') {
    const numValue = ownField(record, 'value');
    if (numValue === 'NaN') return Number.NaN;
    if (numValue === 'Infinity') return Number.POSITIVE_INFINITY;
    if (numValue === '-Infinity') return Number.NEGATIVE_INFINITY;
    if (numValue === '-0') return -0;
  }
  if (tagType === 'pyric/map/1.0') {
    if (isEscapedMapEnvelope(record)) {
      const nextInner: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(record.fields)) {
        defineOwnProperty(nextInner, k, guardMalformedHandAuthoredMarkers(v, mode));
      }
      return { type: 'pyric/map/1.0', fields: nextInner };
    }
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      defineOwnProperty(copy, k, guardMalformedHandAuthoredMarkers(v, mode));
    }
    return { type: 'pyric/map/1.0', fields: copy };
  }

  const refPath = ownField(record, 'path');
  if (dunderType === 'reference' && typeof refPath === 'string') {
    const relPath = normalizeRelativeRefPath(refPath);
    let databaseId = extractRefDatabaseId(refPath);
    const explicitDb = ownField(record, 'databaseId');
    if (typeof explicitDb === 'string' && explicitDb.length > 0) {
      databaseId = explicitDb;
    }
    if (mode === 'env' && databaseId !== DEFAULT_DB_ID) {
      return {
        __type: 'reference',
        path: `projects/_/databases/${databaseId}/documents/${relPath}`,
      };
    }
    return { __type: 'reference', path: relPath };
  }

  const isValidTimestampTag =
    tagType === 'firestore/timestamp/1.0' &&
    typeof ownField(record, 'seconds') === 'number' &&
    typeof ownField(record, 'nanoseconds') === 'number';
  const isValidBytesTag =
    tagType === 'firestore/bytes/1.0' && typeof ownField(record, 'bytes') === 'string';
  const isValidGeoPointTag =
    tagType === 'firestore/geoPoint/1.0' &&
    typeof ownField(record, 'latitude') === 'number' &&
    typeof ownField(record, 'longitude') === 'number';
  const isValidVectorTag =
    tagType === 'firestore/vectorValue/1.0' && Array.isArray(ownField(record, 'vectorValues'));
  const isValidDunderTimestamp =
    dunderType === 'timestamp' &&
    typeof ownField(record, 'seconds') === 'number' &&
    typeof ownField(record, 'nanos') === 'number';
  const isValidDunderBytes =
    dunderType === 'bytes' && typeof ownField(record, 'base64') === 'string';
  const isValidDunderLatLng =
    dunderType === 'latlng' &&
    typeof ownField(record, 'lat') === 'number' &&
    typeof ownField(record, 'lng') === 'number';
  const isValidDunderDuration =
    dunderType === 'duration' &&
    typeof ownField(record, 'seconds') === 'number' &&
    typeof ownField(record, 'nanos') === 'number';
  const isValidDunderPath =
    dunderType === 'path' && Array.isArray(ownField(record, 'segments'));
  const isValidDunderVector =
    dunderVectorType === '__vector__' && Array.isArray(ownField(record, 'value'));

  const isRecognizedValidMarker =
    isValidTimestampTag ||
    isValidBytesTag ||
    isValidGeoPointTag ||
    isValidVectorTag ||
    isValidDunderTimestamp ||
    isValidDunderBytes ||
    isValidDunderLatLng ||
    isValidDunderDuration ||
    isValidDunderPath ||
    isValidDunderVector;
  if (isRecognizedValidMarker) return record;

  const claimsKnownMarkerWithoutShape =
    tagType === 'firestore/timestamp/1.0' ||
    tagType === 'firestore/bytes/1.0' ||
    tagType === 'firestore/geoPoint/1.0' ||
    tagType === 'firestore/vectorValue/1.0' ||
    dunderType === 'timestamp' ||
    dunderType === 'bytes' ||
    dunderType === 'latlng' ||
    dunderType === 'reference' ||
    dunderType === 'duration' ||
    dunderType === 'path' ||
    dunderVectorType === '__vector__';

  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    defineOwnProperty(next, key, guardMalformedHandAuthoredMarkers(item, mode));
  }
  if (claimsKnownMarkerWithoutShape || Object.hasOwn(next, '__proto__')) {
    return { type: 'pyric/map/1.0', fields: next };
  }
  return next;
}

function unwrapTopLevelFields(encoded: EncodedMap): Readonly<Record<string, unknown>> {
  if (isEscapedMapEnvelope(encoded)) {
    return encoded.fields;
  }
  return encoded;
}

/** Decode an `EncodedMap` (or plain JSON seed map) into Firestore SDK values. */
export function decodeSnapshotMap(
  encoded: EncodedMap,
  references: ReferenceDecoder,
): Record<string, unknown> {
  const fields = unwrapTopLevelFields(encoded);
  const decoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const guarded = guardMalformedHandAuthoredMarkers(value, 'sdk');
    const wrapped = decodeDocValue({ value: guarded }, references, DOC_VALUE_ENCODING) as {
      value: unknown;
    };
    defineOwnProperty(decoded, key, wrapped.value);
  }
  return requireDocumentData(decoded);
}

/** Decode an `EncodedMap` (or plain JSON seed map) into `LocalEnvironment` rules wrappers. */
export function decodeSnapshotMapForEnv(encoded: EncodedMap): Record<string, unknown> {
  const fields = unwrapTopLevelFields(encoded);
  const decoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const guarded = guardMalformedHandAuthoredMarkers(value, 'env');
    const wrapped = rehydrateEncodedDocValue({ value: guarded }, DOC_VALUE_ENCODING) as {
      value: unknown;
    };
    defineOwnProperty(decoded, key, wrapped.value);
  }
  return requireDocumentData(decoded);
}
