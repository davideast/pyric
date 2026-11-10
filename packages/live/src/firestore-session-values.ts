/**
 * Copies the Firestore values a client-SDK call observed into the bounded,
 * JSON-shaped form a live host keeps for the session: plain JSON plus the
 * five serialized Firestore shapes (`Timestamp`, `GeoPoint`, `Bytes`,
 * `VectorValue`, `DocumentReference`), and the `set` and `update` ops a
 * write names (`docs/{docId}` with its fields, merge fields and deleted
 * fields).
 *
 * Every copy spends a `SessionBudget` in UTF-8 bytes of its JSON
 * (`session-budget.ts`); one that runs past it is `oversized`, and one that
 * holds anything else (a class instance, a forbidden key, a write sentinel
 * where none is allowed) is `unsupported`. Never calls the app's code.
 */
import { canonicalPath, isObject } from './firestore.js';
import { isPlainObject } from './json-copy.js';
import {
  chargeContainer,
  chargeJson,
  chargeScalar,
  chargeString,
  MAX_SESSION_ITEM_BYTES,
  type SessionBudget,
} from './session-budget.js';
import type { ObservedFirestoreSessionOp } from './session-data.js';

export function defineOwn<T extends Record<string, unknown>>(target: T, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** The deepest nesting a session copy keeps; the host refuses deeper. */
export const MAX_SESSION_DEPTH = 20;
/** The longest document path a session op names. */
const MAX_DOC_PATH_LENGTH = 1024;
/** The most segments a document path has. */
const MAX_DOC_PATH_SEGMENTS = 32;
/** The longest field path read from a string `mergeFields` entry. */
export const MAX_FIELD_PATH_LENGTH = 512;

const OMIT_WRITE_SENTINEL: unique symbol = Symbol('omit-write-sentinel');
export const DELETE_FIELD_SENTINEL: unique symbol = Symbol('delete-field-sentinel');
export const OVER_BUDGET: unique symbol = Symbol('over-budget');
export const UNSUPPORTED: unique symbol = Symbol('unsupported');
export const FORBIDDEN_SESSION_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
export const ESCAPED_PLAIN_MAP_TYPE = 'pyric/map/1.0' as const;

/** True when `value` has the exact `{ type: 'pyric/map/1.0', fields: <plainObject> }` escape envelope shape. */
export function isEscapedPlainMapShape(value: Record<string, unknown>): boolean {
  return (
    Object.keys(value).length === 2 &&
    value.type === ESCAPED_PLAIN_MAP_TYPE &&
    isPlainObject(value.fields)
  );
}

/** True when a plain user map has the exact key signature of a serialized Firestore special value or map envelope. */
export function collidesWithSessionSpecialShape(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  if (
    keys.length === 2 &&
    typeof value.seconds === 'number' &&
    typeof value.nanoseconds === 'number'
  ) {
    return true;
  }
  if (
    keys.length === 2 &&
    typeof value.latitude === 'number' &&
    typeof value.longitude === 'number'
  ) {
    return true;
  }
  if (
    keys.length === 2 &&
    value.type === 'firestore/bytes/1.0' &&
    typeof value.bytes === 'string'
  ) {
    return true;
  }
  if (
    keys.length === 2 &&
    value.__type__ === '__vector__' &&
    Array.isArray(value.value)
  ) {
    return true;
  }
  if (
    keys.length === 3 &&
    value.type === 'document' &&
    typeof value.path === 'string' &&
    typeof value.id === 'string'
  ) {
    return true;
  }
  if (isEscapedPlainMapShape(value)) {
    return true;
  }
  return (
    value.type === 'firestore/timestamp/1.0' ||
    value.type === 'firestore/geoPoint/1.0' ||
    value.type === 'firestore/vectorValue/1.0' ||
    value.__type === 'reference'
  );
}

/** A copied value, or why it was left out. */
export type SessionCopyResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'oversized' | 'unsupported' };

/** The fields a write sent, with deleted field paths and whether non-delete write sentinels were omitted. */
export interface SessionWriteFields {
  readonly data: Record<string, unknown>;
  readonly deleteFields?: string[];
  readonly partial?: boolean;
}

interface WriteCopyMeta {
  readonly deleteFields: string[];
  readonly deleteOmittedFields: boolean;
  omittedSentinel: boolean;
}

export const OVERSIZED_RESULT = { ok: false, reason: 'oversized' } as const;
export const UNSUPPORTED_RESULT = { ok: false, reason: 'unsupported' } as const;

/** A fresh budget for one observed document. */
export function itemBudget(): SessionBudget {
  return { left: MAX_SESSION_ITEM_BYTES };
}

/** Whether a path names a document (`docs/{docId}`, an even count of safe segments). */
export function isValidDocPath(path: string | undefined): path is string {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_DOC_PATH_LENGTH) return false;
  const parts = normalizeDocPath(path).split('/');
  return (
    parts.length >= 2 &&
    parts.length % 2 === 0 &&
    parts.length <= MAX_DOC_PATH_SEGMENTS &&
    parts.every((seg) => seg.length > 0 && seg !== '.' && seg !== '..' && !FORBIDDEN_SESSION_KEYS.has(seg))
  );
}

/** A document path without its leading slash. */
export function normalizeDocPath(path: string): string {
  if (path.startsWith('/')) return path.slice(1);
  return path;
}

function uint8ToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    return btoa(binary);
  }
  const buf = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (buf === undefined) return '';
  return buf.from(bytes).toString('base64');
}

/** A field path as a dotted string, from a string or a `FieldPath`. */
function fieldPathString(raw: unknown): string | undefined {
  if (typeof raw === 'string' && raw.length > 0 && raw.length <= MAX_FIELD_PATH_LENGTH) return raw;
  if (!isObject(raw)) return undefined;
  const internal: unknown = Reflect.get(raw, '_internalPath');
  if (isObject(internal)) {
    const canonical = canonicalPath(internal);
    if (typeof canonical === 'string' && canonical.length > 0) return canonical;
    const segments: unknown = Reflect.get(internal, 'segments');
    if (Array.isArray(segments) && segments.length > 0 && segments.every((s) => typeof s === 'string' && s.length > 0)) {
      return segments.join('.');
    }
  }
  const direct = canonicalPath(raw);
  if (typeof direct === 'string' && direct.length > 0) return direct;
  return undefined;
}

/** Whether a dotted field path has an empty or forbidden segment. */
export function isUnsafeFieldPath(fieldPath: string): boolean {
  return fieldPath.split('.').some((seg) => seg.length === 0 || FORBIDDEN_SESSION_KEYS.has(seg));
}

/** A serialized SDK value, charged at its JSON size, or `OVER_BUDGET`. */
export function charged(budget: SessionBudget, value: unknown): unknown {
  if (!chargeJson(budget, value)) return OVER_BUDGET;
  return value;
}

/** Records a `deleteField()` path, charged as the string the op carries. */
export function noteDeleteField(deleteFields: string[] | undefined, fieldPath: string, budget: SessionBudget): void {
  if (deleteFields === undefined) return;
  chargeString(budget, fieldPath);
  deleteFields.push(fieldPath);
}

/** The JSON form of an SDK `Timestamp`, `GeoPoint`, `Bytes`, `VectorValue` or `DocumentReference`, or undefined for any other object. */
export function serializedSdkValue(value: object): unknown {
  // Firestore Timestamp (`seconds`, `nanoseconds`, `toMillis` / `toDate`)
  const seconds: unknown = Reflect.get(value, 'seconds');
  const nanoseconds: unknown = Reflect.get(value, 'nanoseconds');
  const isTimestamp =
    typeof seconds === 'number' &&
    Number.isFinite(seconds) &&
    typeof nanoseconds === 'number' &&
    Number.isFinite(nanoseconds) &&
    (typeof Reflect.get(value, 'toMillis') === 'function' || typeof Reflect.get(value, 'toDate') === 'function');
  if (isTimestamp) return { seconds: Math.trunc(seconds), nanoseconds: Math.trunc(nanoseconds) };

  // Firestore GeoPoint (`latitude`, `longitude`)
  const latitude: unknown = Reflect.get(value, 'latitude');
  const longitude: unknown = Reflect.get(value, 'longitude');
  const isGeoPoint =
    typeof latitude === 'number' &&
    Number.isFinite(latitude) &&
    typeof longitude === 'number' &&
    Number.isFinite(longitude) &&
    !isPlainObject(value);
  if (isGeoPoint) return { latitude, longitude };

  // Firestore Bytes (`toBase64` + `toUint8Array`)
  const toBase64: unknown = Reflect.get(value, 'toBase64');
  if (typeof toBase64 === 'function' && typeof Reflect.get(value, 'toUint8Array') === 'function') {
    const b64: unknown = Reflect.apply(toBase64, value, []);
    if (typeof b64 !== 'string') return UNSUPPORTED;
    return { type: 'firestore/bytes/1.0', bytes: b64 };
  }

  // Firestore VectorValue (`toArray`)
  const toArray: unknown = Reflect.get(value, 'toArray');
  if (typeof toArray === 'function' && !Array.isArray(value) && !isPlainObject(value)) {
    const arr: unknown = Reflect.apply(toArray, value, []);
    if (!Array.isArray(arr) || !arr.every((n) => typeof n === 'number' && Number.isFinite(n))) return UNSUPPORTED;
    return { __type__: '__vector__', value: [...arr] };
  }

  // Firestore DocumentReference (`type === 'document'`, `path`, `id`, SDK instance or ref handle)
  if (Reflect.get(value, 'type') === 'document') {
    const fsHandle: unknown = Reflect.get(value, 'firestore');
    const isDocRefInstance =
      !isPlainObject(value) ||
      (isObject(fsHandle) && ('converter' in value || isObject(Reflect.get(fsHandle, 'app'))));
    if (isDocRefInstance) {
      const refPath: unknown = Reflect.get(value, 'path');
      const refId: unknown = Reflect.get(value, 'id');
      if (typeof refPath === 'string' && isValidDocPath(refPath) && typeof refId === 'string') {
        return { type: 'document', path: normalizeDocPath(refPath), id: refId };
      }
    }
  }
  return undefined;
}

/** The JSON form of a `Date` or `Uint8Array`, or undefined for any other object. */
export function serializedBuiltIn(value: object): unknown {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isFinite(ms)) return UNSUPPORTED;
    const seconds = Math.floor(ms / 1000);
    const nanoseconds = (ms - seconds * 1000) * 1_000_000;
    return { seconds, nanoseconds };
  }
  if (value instanceof Uint8Array) return { type: 'firestore/bytes/1.0', bytes: uint8ToBase64(value) };
  return undefined;
}

/** The write sentinel a `FieldValue` stands for, or undefined when the value is none. */
function writeSentinelOf(value: object): typeof DELETE_FIELD_SENTINEL | typeof OMIT_WRITE_SENTINEL | undefined {
  const methodName: unknown = Reflect.get(value, '_methodName');
  if (typeof methodName !== 'string') return undefined;
  if (methodName === 'deleteField' || methodName === 'FieldValue.delete') return DELETE_FIELD_SENTINEL;
  return OMIT_WRITE_SENTINEL;
}

/**
 * Copy a Firestore value into JSON + the 5 serialized Firestore shapes.
 * In write mode, `deleteField()` returns `DELETE_FIELD_SENTINEL` and other
 * `FieldValue` write sentinels return `OMIT_WRITE_SENTINEL`.
 */
function sessionValueCopy(
  value: unknown,
  depth: number,
  budget: SessionBudget,
  allowWriteSentinels: boolean,
  writeMeta?: WriteCopyMeta,
  currentFieldPrefix?: string,
): unknown {
  if (typeof value === 'string') {
    if (!chargeString(budget, value)) return OVER_BUDGET;
    return value;
  }
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
    if (!chargeScalar(budget, value)) return OVER_BUDGET;
    return value;
  }
  if (!isObject(value) || depth >= MAX_SESSION_DEPTH) return UNSUPPORTED;

  if (allowWriteSentinels) {
    const sentinel = writeSentinelOf(value);
    if (sentinel !== undefined) return sentinel;
  }

  const serialized = serializedBuiltIn(value) ?? serializedSdkValue(value);
  if (serialized === UNSUPPORTED) return UNSUPPORTED;
  if (serialized !== undefined) return charged(budget, serialized);

  if (!chargeContainer(budget)) return OVER_BUDGET;
  if (Array.isArray(value)) return sessionItemsCopy(value, depth, budget, allowWriteSentinels, writeMeta);
  if (!isPlainObject(value)) return UNSUPPORTED;
  return sessionEntriesCopy(value, depth, budget, allowWriteSentinels, writeMeta, currentFieldPrefix);
}

function sessionItemsCopy(
  items: readonly unknown[],
  depth: number,
  budget: SessionBudget,
  allowWriteSentinels: boolean,
  writeMeta: WriteCopyMeta | undefined,
): unknown {
  const copy: unknown[] = [];
  for (const item of items) {
    const copied = sessionValueCopy(item, depth + 1, budget, allowWriteSentinels, writeMeta);
    if (copied === OMIT_WRITE_SENTINEL) {
      if (writeMeta !== undefined) writeMeta.omittedSentinel = true;
      continue;
    }
    if (copied === DELETE_FIELD_SENTINEL) continue;
    if (copied === OVER_BUDGET || budget.left < 0) return OVER_BUDGET;
    if (copied === UNSUPPORTED) return UNSUPPORTED;
    copy.push(copied);
  }
  return copy;
}

function joinFieldPath(prefix: string | undefined, key: string): string {
  if (prefix !== undefined && prefix.length > 0) return `${prefix}.${key}`;
  return key;
}

function sessionEntriesCopy(
  fields: object,
  depth: number,
  budget: SessionBudget,
  allowWriteSentinels: boolean,
  writeMeta: WriteCopyMeta | undefined,
  currentFieldPrefix: string | undefined,
): unknown {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    if (FORBIDDEN_SESSION_KEYS.has(key)) return UNSUPPORTED;
    if (!chargeString(budget, key)) return OVER_BUDGET;
    const nestedPath = joinFieldPath(currentFieldPrefix, key);
    const copied = sessionValueCopy(field, depth + 1, budget, allowWriteSentinels, writeMeta, nestedPath);
    if (copied === DELETE_FIELD_SENTINEL) {
      noteDeleteField(writeMeta?.deleteFields, nestedPath, budget);
      continue;
    }
    if (copied === OMIT_WRITE_SENTINEL) {
      if (writeMeta !== undefined) {
        writeMeta.omittedSentinel = true;
        if (writeMeta.deleteOmittedFields) noteDeleteField(writeMeta.deleteFields, nestedPath, budget);
      }
      continue;
    }
    if (copied === OVER_BUDGET) return OVER_BUDGET;
    if (copied === UNSUPPORTED) return UNSUPPORTED;
    defineOwn(out, key, copied);
  }
  const needsEscape =
    depth > 0 ? collidesWithSessionSpecialShape(out) : isEscapedPlainMapShape(out);
  if (needsEscape) {
    if (!chargeString(budget, ESCAPED_PLAIN_MAP_TYPE)) return OVER_BUDGET;
    return { type: ESCAPED_PLAIN_MAP_TYPE, fields: out };
  }
  return out;
}

/** A copy's result, from what `sessionValueCopy` returned. */
export function resultOf<T>(copied: unknown, budget: SessionBudget): SessionCopyResult<T> {
  if (copied === OVER_BUDGET || budget.left < 0) return OVERSIZED_RESULT;
  if (copied === UNSUPPORTED) return UNSUPPORTED_RESULT;
  return { ok: true, value: copied as T };
}

function isFieldsObject(value: unknown): value is object {
  return isObject(value) && !Array.isArray(value) && isPlainObject(value);
}

/** A copy of a document's stored fields, as a read returned them. */
export function sessionDocFields(value: unknown, budget: SessionBudget = itemBudget()): SessionCopyResult<Record<string, unknown>> {
  if (!isFieldsObject(value)) return UNSUPPORTED_RESULT;
  return resultOf(sessionValueCopy(value, 0, budget, false), budget);
}

/** A copy of the fields a write sent, its write sentinels left out and its deleted fields named. */
export function sessionWriteFields(
  value: unknown,
  budget: SessionBudget = itemBudget(),
  deleteOmittedFields = false,
): SessionCopyResult<SessionWriteFields> {
  if (!isFieldsObject(value)) return UNSUPPORTED_RESULT;
  const writeMeta: WriteCopyMeta = { deleteFields: [], deleteOmittedFields, omittedSentinel: false };
  const copied = resultOf<Record<string, unknown>>(sessionValueCopy(value, 0, budget, true, writeMeta), budget);
  if (!copied.ok) return copied;
  const fields: { data: Record<string, unknown>; deleteFields?: string[]; partial?: boolean } = { data: copied.value };
  if (writeMeta.deleteFields.length > 0) fields.deleteFields = writeMeta.deleteFields;
  if (writeMeta.omittedSentinel) fields.partial = true;
  return { ok: true, value: fields };
}

export function readNestedAtFieldPath(source: object, dottedPath: string): { found: boolean; value: unknown } {
  const parts = dottedPath.split('.');
  let cursor: unknown = source;
  for (const part of parts) {
    if (!isObject(cursor) || !Object.prototype.hasOwnProperty.call(cursor, part)) {
      return { found: false, value: undefined };
    }
    cursor = Reflect.get(cursor, part);
  }
  return { found: true, value: cursor };
}

/** The fields of an update op, keyed by dotted field path, filled one field at a time. */
class UpdateFields {
  readonly data: Record<string, unknown> = {};
  readonly writeMeta: WriteCopyMeta = { deleteFields: [], deleteOmittedFields: true, omittedSentinel: false };
  readonly budget: SessionBudget;

  constructor(budget: SessionBudget) {
    this.budget = budget;
  }

  /** Copies one field's value under its path; a result when the op must stop, undefined to go on. */
  add(fieldPath: string, rawValue: unknown): SessionCopyResult<never> | undefined {
    if (isUnsafeFieldPath(fieldPath)) return UNSUPPORTED_RESULT;
    if (!chargeString(this.budget, fieldPath)) return OVERSIZED_RESULT;
    const copied = sessionValueCopy(rawValue, 1, this.budget, true, this.writeMeta, fieldPath);
    if (copied === DELETE_FIELD_SENTINEL) {
      noteDeleteField(this.writeMeta.deleteFields, fieldPath, this.budget);
      return undefined;
    }
    if (copied === OMIT_WRITE_SENTINEL) {
      this.writeMeta.omittedSentinel = true;
      noteDeleteField(this.writeMeta.deleteFields, fieldPath, this.budget);
      return undefined;
    }
    if (copied === OVER_BUDGET || this.budget.left < 0) return OVERSIZED_RESULT;
    if (copied === UNSUPPORTED) return UNSUPPORTED_RESULT;
    defineOwn(this.data, fieldPath, copied);
    return undefined;
  }

  /** The finished `update` op for a document path. */
  op(path: string): SessionCopyResult<ObservedFirestoreSessionOp> {
    if (this.budget.left < 0) return OVERSIZED_RESULT;
    const op: {
      kind: 'update';
      path: string;
      data: Record<string, unknown>;
      deleteFields?: string[];
      partial?: boolean;
    } = {
      kind: 'update',
      path,
      data: this.data,
    };
    if (this.writeMeta.deleteFields.length > 0) op.deleteFields = this.writeMeta.deleteFields;
    if (this.writeMeta.omittedSentinel) op.partial = true;
    return { ok: true, value: op };
  }
}

/** The `mergeFields` a `setDoc` option names, or undefined when it names none. */
export function mergeFieldsOf(rawOptions: unknown): unknown[] | undefined {
  if (!isObject(rawOptions)) return undefined;
  const mergeFields: unknown = Reflect.get(rawOptions, 'mergeFields');
  if (!Array.isArray(mergeFields)) return undefined;
  return mergeFields;
}

/** A `setDoc` with `mergeFields`: an `update` op of just the named fields the data holds. */
function sessionMergeFieldsOp(
  path: string,
  rawData: unknown,
  mergeFields: readonly unknown[],
  budget: SessionBudget,
): SessionCopyResult<ObservedFirestoreSessionOp> {
  if (!isObject(rawData) || Array.isArray(rawData)) return UNSUPPORTED_RESULT;
  const fields = new UpdateFields(budget);
  if (!chargeContainer(budget)) return OVERSIZED_RESULT;
  for (const rawField of mergeFields) {
    const fieldPath = fieldPathString(rawField);
    if (fieldPath === undefined || isUnsafeFieldPath(fieldPath)) return UNSUPPORTED_RESULT;
    const lookup = readNestedAtFieldPath(rawData, fieldPath);
    if (!lookup.found) continue;
    const stop = fields.add(fieldPath, lookup.value);
    if (stop !== undefined) return stop;
  }
  return fields.op(path);
}

/** The op a `setDoc` or batch `set` names: a `set` (with `merge`), or an `update` for `mergeFields`. */
export function sessionSetDocOp(
  docPath: string,
  rawData: unknown,
  rawOptions: unknown,
  budget: SessionBudget = itemBudget(),
): SessionCopyResult<ObservedFirestoreSessionOp> {
  if (!isValidDocPath(docPath)) return UNSUPPORTED_RESULT;
  const path = normalizeDocPath(docPath);
  const mergeFields = mergeFieldsOf(rawOptions);
  if (mergeFields !== undefined) return sessionMergeFieldsOp(path, rawData, mergeFields, budget);
  const merge = isObject(rawOptions) && Reflect.get(rawOptions, 'merge') === true;
  const fields = sessionWriteFields(rawData, budget, merge);
  if (!fields.ok) return fields;
  const op: {
    kind: 'set';
    path: string;
    data: Record<string, unknown>;
    merge?: boolean;
    deleteFields?: string[];
    partial?: boolean;
  } = {
    kind: 'set',
    path,
    data: fields.value.data,
  };
  if (merge) op.merge = true;
  if (fields.value.deleteFields !== undefined) op.deleteFields = fields.value.deleteFields;
  if (fields.value.partial === true) op.partial = true;
  return { ok: true, value: op };
}

/** The `update` op an `updateDoc` or batch `update` names, from its object or its variadic field/value pairs. */
export function sessionUpdateDocOp(
  docPath: string,
  restArgs: readonly unknown[],
  budget: SessionBudget = itemBudget(),
): SessionCopyResult<ObservedFirestoreSessionOp> {
  if (!isValidDocPath(docPath) || restArgs.length === 0) return UNSUPPORTED_RESULT;
  const path = normalizeDocPath(docPath);
  const fields = new UpdateFields(budget);
  if (!chargeContainer(budget)) return OVERSIZED_RESULT;

  if (restArgs.length === 1) {
    const payload = restArgs[0];
    if (!isFieldsObject(payload)) return UNSUPPORTED_RESULT;
    for (const [fieldPath, rawValue] of Object.entries(payload)) {
      const stop = fields.add(fieldPath, rawValue);
      if (stop !== undefined) return stop;
    }
    return fields.op(path);
  }

  for (let i = 0; i + 1 < restArgs.length; i += 2) {
    const fieldPath = fieldPathString(restArgs[i]);
    if (fieldPath === undefined) return UNSUPPORTED_RESULT;
    const stop = fields.add(fieldPath, restArgs[i + 1]);
    if (stop !== undefined) return stop;
  }
  return fields.op(path);
}
