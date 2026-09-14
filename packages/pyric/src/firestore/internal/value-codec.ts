/**
 * Firestore wire values shared by browser transports and sandbox persistence.
 *
 * Declared wire encodings can escape marker-shaped maps; legacy persistence
 * retains its marker interpretation. SDK decoding restores public scalar values
 * and references owned by the receiving client. Persistence decoding retains
 * the rules wrappers used by the evaluator. Direct value
 * imports keep this module independent of the sandbox and rules engines.
 *
 * Encoding escapes ordinary maps with marker keys before they cross the wire.
 * Legacy unknown markers remain maps. Complete validation and write-intent
 * handling are still required by the wire contract.
 */
import { Bytes as RulesBytes } from '../../rules/simulator/wrappers/bytes.js';
import { Duration } from '../../rules/simulator/wrappers/duration.js';
import { LatLng } from '../../rules/simulator/wrappers/latlng.js';
import { Path } from '../../rules/simulator/wrappers/path.js';
import { Reference } from '../../rules/simulator/wrappers/reference.js';
import { Timestamp as RulesTimestamp } from '../../rules/simulator/wrappers/timestamp.js';
import { Vector } from '../../rules/simulator/wrappers/vector.js';
import { Timestamp } from '../timestamp.js';
import { Bytes } from '../bytes.js';
import { GeoPoint } from '../geo-point.js';
import { VectorValue } from '../vector-value.js';
import { FirebaseError } from '../../sandbox/internal/firebase-error.js';
// Sideways leaf import into the firestore surface (same character as the
// wrapper imports above): the activity value registry is a zero-dependency
// leaf owned by `firestore/sandbox/`, consumed here only to stamp trusted
// wire identities on rehydrated values. It pulls no backend code.
import {
  registerActivityValue,
  trustedWireActivityValue,
} from '../sandbox/activity-value-registry.js';
import { registerQueryValue, registeredReferenceQueryValuePath } from '../sandbox/query-value-registry.js';
export { registerReferenceQueryValue } from '../sandbox/query-value-registry.js';
export { requireDocumentData } from './document-data.js';

export const DOC_VALUE_ENCODING = 'pyric/firestore-values/1';
export type DocValueEncoding = typeof DOC_VALUE_ENCODING;

function resolveMapEncoding(encoding: DocValueEncoding | undefined): boolean {
  const isLegacyEncoding = encoding === undefined;
  const allowsEscapedMaps = encoding === DOC_VALUE_ENCODING;
  const isUnsupportedEncoding = !isLegacyEncoding && !allowsEscapedMaps;
  if (isUnsupportedEncoding) {
    throw new FirebaseError('invalid-argument', 'Unsupported Firestore value encoding.');
  }
  return allowsEscapedMaps;
}

/** Encode SDK values before transport removes their class or copies their owner. */
export function encodeDocValue(value: unknown): unknown {
  const isScalar = value === null || typeof value !== 'object';
  if (isScalar) return value;
  const isTimestamp = value instanceof Timestamp;
  if (isTimestamp) return value.toJSON();
  const isDate = value instanceof Date;
  if (isDate) return Timestamp.fromDate(value).toJSON();
  const isBytes = value instanceof Bytes;
  if (isBytes) return value.toJSON();
  const isGeoPoint = value instanceof GeoPoint;
  if (isGeoPoint) return value.toJSON();
  const isVector = value instanceof VectorValue;
  if (isVector) return value.toJSON();
  const referencePath = registeredReferenceQueryValuePath(value);
  const isReference = referencePath !== undefined;
  if (isReference) return { __type: 'reference', path: referencePath };
  const isArray = Array.isArray(value);
  if (isArray) return value.map(encodeDocValue);
  const prototype = Object.getPrototypeOf(value);
  const isPlainMap = prototype === Object.prototype || prototype === null;
  if (isPlainMap) {
    const fields = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeDocValue(item)]));
    const hasMarkerField = Object.hasOwn(fields, 'type')
      || Object.hasOwn(fields, '__type')
      || Object.hasOwn(fields, '__type__');
    if (hasMarkerField) return { type: 'pyric/map/1.0', fields };
    return fields;
  }
  return value;
}

/** A decoder's owner supplies usable references; persistence keeps rules values. */
export interface ReferenceDecoder {
  create(path: string): object;
}

interface ValueConstructors {
  bytes(value: Uint8Array): object;
  geoPoint(latitude: number, longitude: number): object;
  reference(path: string): object;
  timestamp(seconds: number, nanoseconds: number): object;
  vector(values: readonly number[]): object;
}

const rulesValues: ValueConstructors = {
  bytes: (value) => new RulesBytes(value),
  geoPoint: (latitude, longitude) => new LatLng(latitude, longitude),
  reference: (path) => new Reference(path),
  timestamp: (seconds, nanoseconds) => new RulesTimestamp(seconds, nanoseconds),
  vector: (values) => new Vector(values),
};

/**
 * Decode a base64url string (`-`/`_` alphabet, no padding) back into a
 * Uint8Array. Mirrors the encode path in `Bytes.toBase64` (RFC 4648 section 5).
 */
function base64UrlDecode(s: string): Uint8Array {
  const std = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = std.length % 4 === 0 ? '' : '='.repeat(4 - (std.length % 4));
  const bin = atob(std + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Decode a standard base64 string (`+`/`/` alphabet, possibly `=`-padded)
 * back to a Uint8Array. Used for `firebase/firestore` Bytes which encode in
 * standard base64 (unlike pyric/rules Bytes which use base64url).
 */
function base64StdDecode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Restore persisted marker trees to rules values, including nested maps and arrays. */
export function rehydrateDocValue(value: unknown): unknown {
  return rehydrateValue(value, true, rulesValues, false);
}

/** Decode explicitly declared wire values; absent declarations retain the legacy marker contract. */
export function rehydrateEncodedDocValue(value: unknown, encoding: DocValueEncoding | undefined): unknown {
  const allowsEscapedMaps = resolveMapEncoding(encoding);
  return rehydrateValue(value, true, rulesValues, allowsEscapedMaps);
}

/** Decode values for an SDK owner while retaining the unary persistence decoder. */
export function decodeDocValue(value: unknown, references: ReferenceDecoder, encoding?: DocValueEncoding): unknown {
  const allowsEscapedMaps = resolveMapEncoding(encoding);
  return rehydrateValue(value, true, {
    bytes: (value) => Bytes.fromUint8Array(value),
    geoPoint: (latitude, longitude) => new GeoPoint(latitude, longitude),
    reference: (path) => references.create(path),
    timestamp: (seconds, nanoseconds) => new Timestamp(seconds, nanoseconds),
    vector: (values) => VectorValue.create(values.slice()),
  }, allowsEscapedMaps);
}

function rehydrateValue(value: unknown, registerRootIdentity: boolean, constructors: ValueConstructors, allowsEscapedMaps: boolean): unknown {
  const isScalar = value === null || typeof value !== 'object';
  if (isScalar) return value;
  const isArray = Array.isArray(value);
  if (isArray) {
    const hydrated = value.map((item) => rehydrateValue(item, false, constructors, allowsEscapedMaps));
    if (registerRootIdentity) {
      registerActivityValue(hydrated, trustedWireActivityValue(value));
    }
    return hydrated;
  }

  const obj = value as Record<string, unknown>;
  const withActivityIdentity = <T extends object>(hydrated: T): T => {
    if (registerRootIdentity) {
      registerActivityValue(hydrated, trustedWireActivityValue(value));
    }
    return hydrated;
  };
  const withQueryIdentity = <T extends object>(hydrated: T, snapshot: unknown): T => {
    registerQueryValue(hydrated, Object.freeze(snapshot as object), () => hydrated);
    return withActivityIdentity(hydrated);
  };

  const isVector = obj.__type__ === '__vector__' && Array.isArray(obj.value);
  if (isVector) {
    const values = Object.freeze((obj.value as number[]).slice());
    return withQueryIdentity(constructors.vector(values), { type: 'vector', values });
  }

  // pyric/rules wrapper marker form (used for IDB persistence + wire).
  const hasWrapperMarker = typeof obj.__type === 'string';
  if (hasWrapperMarker) {
    switch (obj.__type) {
      case 'timestamp':
        return withQueryIdentity(
          constructors.timestamp(obj.seconds as number, obj.nanos as number),
          { type: 'timestamp', seconds: obj.seconds, nanoseconds: obj.nanos },
        );
      case 'bytes': {
        const bytes = base64UrlDecode(obj.base64 as string);
        return withQueryIdentity(
          constructors.bytes(bytes),
          { type: 'bytes', values: Object.freeze(Array.from(bytes)) },
        );
      }
      case 'latlng':
        return withQueryIdentity(
          constructors.geoPoint(obj.lat as number, obj.lng as number),
          { type: 'geo-point', latitude: obj.lat, longitude: obj.lng },
        );
      case 'duration':
        return withActivityIdentity(new Duration(obj.seconds as number, obj.nanos as number));
      case 'reference': {
        const path = obj.path as string;
        return withActivityIdentity(constructors.reference(path));
      }
      case 'path':
        return withActivityIdentity(new Path(obj.segments as string[]));
    }
  }

  const isEscapedMap = allowsEscapedMaps && obj.type === 'pyric/map/1.0';
  if (isEscapedMap) {
    const fields = obj.fields;
    const hasInvalidMapFields = fields === null || typeof fields !== 'object' || Array.isArray(fields);
    if (hasInvalidMapFields) throw new TypeError('Invalid encoded map fields.');
    const hydrated = Object.fromEntries(
      Object.entries(fields).map(([key, item]) => [key, rehydrateValue(item, false, constructors, allowsEscapedMaps)]),
    );
    return withActivityIdentity(hydrated);
  }

  // Versioned markers distinguish SDK values from escaped user maps.
  const hasVersionedMarker = typeof obj.type === 'string';
  if (hasVersionedMarker) {
    switch (obj.type) {
      case 'firestore/timestamp/1.0': {
        // fb.Timestamp.toJSON() emits { type, seconds, nanoseconds }.
        // The rules Timestamp uses nanos (not nanoseconds) — same value.
        const seconds = obj.seconds as number;
        const nanoseconds = obj.nanoseconds as number;
        return withQueryIdentity(
          constructors.timestamp(seconds, nanoseconds),
          { type: 'timestamp', seconds, nanoseconds },
        );
      }
      case 'firestore/bytes/1.0': {
        // fb.Bytes.toJSON() emits { type, bytes } where bytes is standard base64.
        const bytes = base64StdDecode(obj.bytes as string);
        return withQueryIdentity(
          constructors.bytes(bytes),
          { type: 'bytes', values: Object.freeze(Array.from(bytes)) },
        );
      }
      case 'firestore/geoPoint/1.0': {
        // fb.GeoPoint.toJSON() emits { latitude, longitude, type }.
        return withQueryIdentity(
          constructors.geoPoint(obj.latitude as number, obj.longitude as number),
          { type: 'geo-point', latitude: obj.latitude, longitude: obj.longitude },
        );
      }
      case 'firestore/vectorValue/1.0': {
        const vector = VectorValue.fromJSON(obj);
        const values = Object.freeze(vector.toArray());
        return withQueryIdentity(constructors.vector(values), { type: 'vector', values });
      }
    }
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = rehydrateValue(v, false, constructors, allowsEscapedMaps);
  return withActivityIdentity(out);
}
