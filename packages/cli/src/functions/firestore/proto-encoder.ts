/**
 * Minimal binary Protocol Buffers encoder for
 * `google.events.cloud.firestore.v1.DocumentEventData` matching the schema
 * compiled into `firebase-functions` 7.2.5 (`protos/compiledFirestore.js`).
 */
import {
  Bytes as RulesBytes,
  LatLng as RulesLatLng,
  Reference as RulesReference,
  Timestamp as RulesTimestamp,
  Vector as RulesVector,
} from 'pyric/rules/internal';
import { normalizeFirestoreDocumentPath } from './document-pattern.js';

export interface FirestoreTimestampProto {
  readonly seconds: number;
  readonly nanos: number;
}

interface FirestoreDocumentProtoInput {
  readonly name: string;
  readonly fields: Record<string, unknown>;
  readonly createTime: FirestoreTimestampProto;
  readonly updateTime: FirestoreTimestampProto;
}

export interface FirestoreDocumentEventDataInput {
  readonly value?: FirestoreDocumentProtoInput;
  readonly oldValue?: FirestoreDocumentProtoInput;
  readonly updateMask?: readonly string[];
}

export interface FirestoreProtoEncodeContext {
  readonly projectId: string;
  readonly database: string;
}

/** Branded reference holder for decoded cross-wire DocumentReferences. */
export class FirestoreReferenceValue {
  readonly path: string;
  readonly databaseId?: string;

  constructor(path: string, databaseId?: string) {
    this.path = normalizeFirestoreDocumentPath(path);
    if (databaseId !== undefined && databaseId.length > 0) {
      this.databaseId = databaseId;
    }
  }
}

class ProtoByteWriter {
  readonly #chunks: Uint8Array[] = [];
  #totalLength = 0;

  writeUint32(value: number): void {
    let remaining = value >>> 0;
    const bytes: number[] = [];
    while (remaining > 0x7f) {
      bytes.push((remaining & 0x7f) | 0x80);
      remaining >>>= 7;
    }
    bytes.push(remaining);
    this.writeRawBytes(Uint8Array.from(bytes));
  }

  writeInt64(value: number | bigint): void {
    let bits = BigInt.asUintN(64, typeof value === 'bigint' ? value : BigInt(Math.trunc(value)));
    const bytes: number[] = [];
    while (bits > 0x7fn) {
      bytes.push(Number(bits & 0x7fn) | 0x80);
      bits >>= 7n;
    }
    bytes.push(Number(bits));
    this.writeRawBytes(Uint8Array.from(bytes));
  }

  writeInt32(value: number): void {
    if (value < 0) {
      this.writeInt64(BigInt(value));
      return;
    }
    this.writeUint32(value);
  }

  writeDouble(value: number): void {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, value, true);
    this.writeRawBytes(new Uint8Array(buf));
  }

  writeBytes(tag: number, payload: Uint8Array): void {
    this.writeUint32(tag);
    this.writeUint32(payload.byteLength);
    this.writeRawBytes(payload);
  }

  writeString(tag: number, text: string): void {
    this.writeBytes(tag, Buffer.from(text, 'utf8'));
  }

  writeRawBytes(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    this.#chunks.push(bytes);
    this.#totalLength += bytes.byteLength;
  }

  finish(): Buffer {
    const out = Buffer.allocUnsafe(this.#totalLength);
    let offset = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function encodeTimestampMessage(ts: FirestoreTimestampProto): Buffer {
  const writer = new ProtoByteWriter();
  writer.writeUint32(8);
  writer.writeInt64(ts.seconds);
  writer.writeUint32(16);
  writer.writeInt32(ts.nanos);
  return writer.finish();
}

function encodeLatLngMessage(latitude: number, longitude: number): Buffer {
  const writer = new ProtoByteWriter();
  writer.writeUint32(9);
  writer.writeDouble(latitude);
  writer.writeUint32(17);
  writer.writeDouble(longitude);
  return writer.finish();
}

function extractClassTimestamp(value: object): FirestoreTimestampProto | null {
  if (value instanceof RulesTimestamp) {
    return { seconds: value.seconds, nanos: value.nanos };
  }
  if (value instanceof Date) {
    const millis = value.getTime();
    const seconds = Math.floor(millis / 1_000);
    const nanos = (millis - seconds * 1_000) * 1_000_000;
    return { seconds, nanos };
  }
  const candidate = value as { seconds?: unknown; nanoseconds?: unknown; toDate?: unknown };
  if (
    typeof candidate.seconds === 'number' &&
    typeof candidate.nanoseconds === 'number' &&
    typeof candidate.toDate === 'function'
  ) {
    return { seconds: candidate.seconds, nanos: candidate.nanoseconds };
  }
  return null;
}

function extractClassGeoPoint(value: object): { latitude: number; longitude: number } | null {
  if (value instanceof RulesLatLng) {
    return { latitude: value.lat, longitude: value.lng };
  }
  const candidate = value as { latitude?: unknown; longitude?: unknown };
  if (typeof candidate.latitude === 'number' && typeof candidate.longitude === 'number') {
    return { latitude: candidate.latitude, longitude: candidate.longitude };
  }
  return null;
}

function extractClassBytes(value: object): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof RulesBytes) {
    return value.data;
  }
  const candidate = value as { toUint8Array?: unknown };
  if (typeof candidate.toUint8Array === 'function') {
    const bytes = (candidate.toUint8Array as () => unknown)();
    if (bytes instanceof Uint8Array) return bytes;
  }
  return null;
}

function formatFullResourceName(
  rawPath: string,
  databaseId: string | undefined,
  context: FirestoreProtoEncodeContext,
): string {
  if (rawPath.startsWith('projects/')) {
    return rawPath;
  }
  const effectiveDb = databaseId ?? context.database;
  const normalized = normalizeFirestoreDocumentPath(rawPath);
  return `projects/${context.projectId}/databases/${effectiveDb}/documents/${normalized}`;
}

function extractClassReference(value: object, context: FirestoreProtoEncodeContext): string | null {
  if (value instanceof FirestoreReferenceValue) {
    return formatFullResourceName(value.path, value.databaseId, context);
  }
  if (value instanceof RulesReference) {
    return formatFullResourceName(value.path, value.databaseId, context);
  }
  const candidate = value as { path?: unknown; firestore?: unknown; parent?: unknown };
  if (
    typeof candidate.path === 'string' &&
    candidate.firestore !== undefined &&
    candidate.parent !== undefined
  ) {
    return formatFullResourceName(candidate.path, undefined, context);
  }
  return null;
}

function extractClassVector(value: object): readonly number[] | null {
  if (value instanceof RulesVector) {
    return value.value;
  }
  const candidate = value as { toArray?: unknown };
  if (typeof candidate.toArray === 'function') {
    const arr = (candidate.toArray as () => unknown)();
    if (Array.isArray(arr) && arr.every((item) => typeof item === 'number')) {
      return arr;
    }
  }
  return null;
}

function encodeMapFieldsEntry(
  key: string,
  fieldValue: Buffer,
): Buffer {
  const entry = new ProtoByteWriter();
  entry.writeString(10, key);
  entry.writeBytes(18, fieldValue);
  return entry.finish();
}

function encodeMapValueMessage(
  record: Record<string, unknown>,
  context: FirestoreProtoEncodeContext,
): Buffer {
  const mapWriter = new ProtoByteWriter();
  for (const [key, item] of Object.entries(record)) {
    if (item === undefined) continue;
    const encodedChild = encodeFirestoreValueMessage(item, context);
    mapWriter.writeBytes(10, encodeMapFieldsEntry(key, encodedChild));
  }
  return mapWriter.finish();
}

function encodeVectorMapValueMessage(values: readonly number[]): Buffer {
  const arrayWriter = new ProtoByteWriter();
  for (const num of values) {
    const elem = new ProtoByteWriter();
    elem.writeUint32(25);
    elem.writeDouble(num);
    arrayWriter.writeBytes(10, elem.finish());
  }
  const arrayValueMsg = new ProtoByteWriter();
  arrayValueMsg.writeBytes(74, arrayWriter.finish());

  const typeStringMsg = new ProtoByteWriter();
  typeStringMsg.writeString(138, '__vector__');

  const mapWriter = new ProtoByteWriter();
  mapWriter.writeBytes(10, encodeMapFieldsEntry('__type__', typeStringMsg.finish()));
  mapWriter.writeBytes(10, encodeMapFieldsEntry('value', arrayValueMsg.finish()));
  return mapWriter.finish();
}

function encodeFirestoreValueMessage(
  value: unknown,
  context: FirestoreProtoEncodeContext,
): Buffer {
  const writer = new ProtoByteWriter();
  if (value === null || value === undefined) {
    writer.writeUint32(88);
    writer.writeInt32(0);
    return writer.finish();
  }
  if (typeof value === 'boolean') {
    writer.writeUint32(8);
    writer.writeUint32(value ? 1 : 0);
    return writer.finish();
  }
  if (typeof value === 'number') {
    const isExactSafeInt =
      Number.isInteger(value) && !Object.is(value, -0) && Number.isSafeInteger(value);
    if (isExactSafeInt) {
      writer.writeUint32(16);
      writer.writeInt64(value);
    } else {
      writer.writeUint32(25);
      writer.writeDouble(value);
    }
    return writer.finish();
  }
  if (typeof value === 'string') {
    writer.writeString(138, value);
    return writer.finish();
  }
  if (Array.isArray(value)) {
    const arrayWriter = new ProtoByteWriter();
    for (const item of value) {
      arrayWriter.writeBytes(10, encodeFirestoreValueMessage(item, context));
    }
    writer.writeBytes(74, arrayWriter.finish());
    return writer.finish();
  }
  if (typeof value === 'object') {
    if (!isPlainRecord(value)) {
      const bytes = extractClassBytes(value);
      if (bytes !== null) {
        writer.writeBytes(146, bytes);
        return writer.finish();
      }
      const ts = extractClassTimestamp(value);
      if (ts !== null) {
        writer.writeBytes(82, encodeTimestampMessage(ts));
        return writer.finish();
      }
      const geo = extractClassGeoPoint(value);
      if (geo !== null) {
        writer.writeBytes(66, encodeLatLngMessage(geo.latitude, geo.longitude));
        return writer.finish();
      }
      const refName = extractClassReference(value, context);
      if (refName !== null) {
        writer.writeString(42, refName);
        return writer.finish();
      }
      const vec = extractClassVector(value);
      if (vec !== null) {
        writer.writeBytes(50, encodeVectorMapValueMessage(vec));
        return writer.finish();
      }
    }
    writer.writeBytes(50, encodeMapValueMessage(value as Record<string, unknown>, context));
    return writer.finish();
  }
  writer.writeString(138, String(value));
  return writer.finish();
}

function encodeDocumentMessage(
  doc: FirestoreDocumentProtoInput,
  context: FirestoreProtoEncodeContext,
): Buffer {
  const writer = new ProtoByteWriter();
  writer.writeString(10, doc.name);
  for (const [key, item] of Object.entries(doc.fields)) {
    if (item === undefined) continue;
    const encodedVal = encodeFirestoreValueMessage(item, context);
    writer.writeBytes(18, encodeMapFieldsEntry(key, encodedVal));
  }
  writer.writeBytes(26, encodeTimestampMessage(doc.createTime));
  writer.writeBytes(34, encodeTimestampMessage(doc.updateTime));
  return writer.finish();
}

function encodeDocumentMaskMessage(fieldPaths: readonly string[]): Buffer {
  const writer = new ProtoByteWriter();
  for (const fieldPath of fieldPaths) {
    writer.writeString(10, fieldPath);
  }
  return writer.finish();
}

/** Encode `DocumentEventData` into a binary protobuf `Buffer` for `firebase-functions/v2/firestore`. */
export function encodeFirestoreDocumentEventData(
  input: FirestoreDocumentEventDataInput,
  context: FirestoreProtoEncodeContext,
): Buffer {
  const writer = new ProtoByteWriter();
  if (input.value !== undefined) {
    writer.writeBytes(10, encodeDocumentMessage(input.value, context));
  }
  if (input.oldValue !== undefined) {
    writer.writeBytes(18, encodeDocumentMessage(input.oldValue, context));
  }
  if (input.updateMask !== undefined) {
    writer.writeBytes(26, encodeDocumentMaskMessage(input.updateMask));
  }
  return writer.finish();
}
