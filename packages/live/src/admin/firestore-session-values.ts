/**
 * Copies the Firestore values an Admin SDK (`@google-cloud/firestore`) call
 * observed into the bounded, JSON-shaped form a live host keeps for the
 * session: plain JSON plus the five serialized Firestore shapes (`Timestamp`,
 * `GeoPoint`, `Bytes`, `VectorValue`, `DocumentReference`), and the `set` and
 * `update` ops an Admin write names.
 *
 * `FieldValue.delete()` is translated into `deleteFields` where the write mode
 * permits field deletion (`set` with `merge` / `mergeFields`, and `update`);
 * server-transform `FieldValue` sentinels (`serverTimestamp`, `increment`,
 * `arrayUnion`, `arrayRemove`) are never approximated locally and count as
 * `unsupported`. Never calls the app's code.
 */
import { isObject } from '../database.js';
import {
  charged,
  DELETE_FIELD_SENTINEL,
  FORBIDDEN_SESSION_KEYS,
  isUnsafeFieldPath,
  isValidDocPath,
  itemBudget,
  MAX_FIELD_PATH_LENGTH,
  MAX_SESSION_DEPTH,
  mergeFieldsOf,
  normalizeDocPath,
  noteDeleteField,
  OVER_BUDGET,
  OVERSIZED_RESULT,
  readNestedAtFieldPath,
  resultOf,
  serializedBuiltIn,
  serializedSdkValue,
  UNSUPPORTED,
  UNSUPPORTED_RESULT,
  type SessionCopyResult,
  type SessionWriteFields,
} from '../firestore-session-values.js';
import { isPlainObject } from '../json-copy.js';
import {
  chargeContainer,
  chargeScalar,
  chargeString,
  type SessionBudget,
} from '../session-budget.js';
import type { ObservedFirestoreSessionOp } from '../session-data.js';

function isAdminFieldPathObject(value: unknown): value is object {
  if (!isObject(value) || Array.isArray(value) || isPlainObject(value)) return false;
  if (typeof Reflect.get(value, 'formattedName') === 'string') return true;
  const ctor: unknown = Reflect.get(value, 'constructor');
  return isObject(ctor) && Reflect.get(ctor, 'name') === 'FieldPath';
}

/**
 * Converts a string field path or an Admin `FieldPath` into a dotted field path.
 * Returns undefined if empty, unsafe, or if a `FieldPath` segment contains a
 * literal dot (which cannot be represented unambiguously as a dotted string).
 */
export function adminFieldPathString(raw: unknown): string | undefined {
  if (typeof raw === 'string') {
    const withinBounds = raw.length > 0 && raw.length <= MAX_FIELD_PATH_LENGTH;
    if (!withinBounds || isUnsafeFieldPath(raw)) return undefined;
    return raw;
  }
  if (!isAdminFieldPathObject(raw)) return undefined;
  const toArray: unknown = Reflect.get(raw, 'toArray');
  if (typeof toArray !== 'function') return undefined;
  const segments: unknown = Reflect.apply(toArray, raw, []);
  if (!Array.isArray(segments) || segments.length === 0) return undefined;
  for (const segment of segments) {
    const usable =
      typeof segment === 'string' &&
      segment.length > 0 &&
      !segment.includes('.') &&
      !FORBIDDEN_SESSION_KEYS.has(segment);
    if (!usable) return undefined;
  }
  const joined = (segments as string[]).join('.');
  if (joined.length > MAX_FIELD_PATH_LENGTH) return undefined;
  return joined;
}

function serializedAdminDocRef(value: object): unknown {
  const internalPath: unknown = Reflect.get(value, '_path');
  if (!isObject(internalPath) || Reflect.get(internalPath, 'isDocument') !== true) return undefined;
  const refPath: unknown = Reflect.get(value, 'path');
  const refId: unknown = Reflect.get(value, 'id');
  if (isValidDocPath(refPath as string | undefined) && typeof refId === 'string') {
    return { type: 'document', path: normalizeDocPath(refPath as string), id: refId };
  }
  return UNSUPPORTED;
}

function adminFieldValueSentinel(value: object): typeof DELETE_FIELD_SENTINEL | typeof UNSUPPORTED | undefined {
  let methodName: unknown = Reflect.get(value, 'methodName');
  if (typeof methodName !== 'string') methodName = Reflect.get(value, '_methodName');
  if (typeof methodName !== 'string') return undefined;
  if (methodName === 'FieldValue.delete' || methodName === 'deleteField') return DELETE_FIELD_SENTINEL;
  return UNSUPPORTED;
}

function isScalarJsonValue(value: unknown): value is null | boolean | number {
  return value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

function copyAdminValue(
  value: unknown,
  depth: number,
  budget: SessionBudget,
  allowDeleteSentinel: boolean,
  deleteFieldsOut?: string[],
  currentFieldPrefix?: string,
): unknown {
  if (typeof value === 'string') {
    if (!chargeString(budget, value)) return OVER_BUDGET;
    return value;
  }
  if (isScalarJsonValue(value)) {
    if (!chargeScalar(budget, value)) return OVER_BUDGET;
    return value;
  }
  if (!isObject(value) || depth >= MAX_SESSION_DEPTH) return UNSUPPORTED;

  const sentinel = adminFieldValueSentinel(value);
  if (sentinel !== undefined) {
    if (allowDeleteSentinel && sentinel === DELETE_FIELD_SENTINEL) return DELETE_FIELD_SENTINEL;
    return UNSUPPORTED;
  }

  let serialized = serializedBuiltIn(value);
  if (serialized === undefined) serialized = serializedSdkValue(value);
  if (serialized === undefined) serialized = serializedAdminDocRef(value);
  if (serialized === UNSUPPORTED) return UNSUPPORTED;
  if (serialized !== undefined) return charged(budget, serialized);

  if (!chargeContainer(budget)) return OVER_BUDGET;
  if (Array.isArray(value)) return copyAdminItems(value, depth, budget);
  if (!isPlainObject(value)) return UNSUPPORTED;
  return copyAdminEntries(value, depth, budget, allowDeleteSentinel, deleteFieldsOut, currentFieldPrefix);
}

function copyAdminItems(items: readonly unknown[], depth: number, budget: SessionBudget): unknown {
  const copy: unknown[] = [];
  for (const item of items) {
    const copied = copyAdminValue(item, depth + 1, budget, false);
    if (copied === OVER_BUDGET || budget.left < 0) return OVER_BUDGET;
    if (copied === UNSUPPORTED) return UNSUPPORTED;
    copy.push(copied);
  }
  return copy;
}

function copyAdminEntries(
  fields: Record<string, unknown>,
  depth: number,
  budget: SessionBudget,
  allowDeleteSentinel: boolean,
  deleteFieldsOut: string[] | undefined,
  currentFieldPrefix: string | undefined,
): unknown {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    if (FORBIDDEN_SESSION_KEYS.has(key)) return UNSUPPORTED;
    if (!chargeString(budget, key)) return OVER_BUDGET;
    let nestedPath = key;
    if (currentFieldPrefix !== undefined) nestedPath = `${currentFieldPrefix}.${key}`;
    const copied = copyAdminValue(field, depth + 1, budget, allowDeleteSentinel, deleteFieldsOut, nestedPath);
    if (copied === DELETE_FIELD_SENTINEL) {
      noteDeleteField(deleteFieldsOut, nestedPath, budget);
      continue;
    }
    if (copied === OVER_BUDGET || budget.left < 0) return OVER_BUDGET;
    if (copied === UNSUPPORTED) return UNSUPPORTED;
    out[key] = copied;
  }
  return out;
}

/** Bounded copy of a read document's stored fields. */
export function adminDocFields(
  value: unknown,
  budget: SessionBudget = itemBudget(),
): SessionCopyResult<Record<string, unknown>> {
  if (!isPlainObject(value)) return UNSUPPORTED_RESULT;
  return resultOf(copyAdminValue(value, 0, budget, false), budget);
}

function adminWriteFields(
  value: unknown,
  allowDeleteSentinel: boolean,
  budget: SessionBudget,
): SessionCopyResult<SessionWriteFields> {
  if (!isPlainObject(value)) return UNSUPPORTED_RESULT;
  const deleteFields: string[] = [];
  const copied = resultOf<Record<string, unknown>>(
    copyAdminValue(value, 0, budget, allowDeleteSentinel, deleteFields),
    budget,
  );
  if (!copied.ok) return copied;
  const fields: { data: Record<string, unknown>; deleteFields?: string[] } = { data: copied.value };
  if (deleteFields.length > 0) fields.deleteFields = deleteFields;
  return { ok: true, value: fields };
}

/** Bounded copy of `CollectionReference.add(data)` fields before the document path resolves. */
export function adminAddDocFields(
  rawData: unknown,
  budget: SessionBudget = itemBudget(),
): SessionCopyResult<SessionWriteFields> {
  return adminWriteFields(rawData, false, budget);
}

/** Bounded `set` op for `DocumentReference.create` / `WriteBatch.create` / `Transaction.create`. */
export function adminCreateDocOp(
  docPath: string,
  rawData: unknown,
  budget: SessionBudget = itemBudget(),
): SessionCopyResult<ObservedFirestoreSessionOp> {
  if (!isValidDocPath(docPath)) return UNSUPPORTED_RESULT;
  const fields = adminWriteFields(rawData, false, budget);
  if (!fields.ok) return fields;
  return {
    ok: true,
    value: {
      kind: 'set',
      path: normalizeDocPath(docPath),
      data: fields.value.data,
    },
  };
}

interface AdminUpdateAccumulator {
  readonly data: Record<string, unknown>;
  readonly deleteFields: string[];
  readonly budget: SessionBudget;
}

function createUpdateAccumulator(budget: SessionBudget): AdminUpdateAccumulator {
  return { data: {}, deleteFields: [], budget };
}

function addUpdateField(
  acc: AdminUpdateAccumulator,
  fieldPath: string,
  rawValue: unknown,
): SessionCopyResult<never> | undefined {
  if (isUnsafeFieldPath(fieldPath)) return UNSUPPORTED_RESULT;
  if (!chargeString(acc.budget, fieldPath)) return OVERSIZED_RESULT;
  const copied = copyAdminValue(rawValue, 0, acc.budget, true, acc.deleteFields, fieldPath);
  if (copied === DELETE_FIELD_SENTINEL) {
    noteDeleteField(acc.deleteFields, fieldPath, acc.budget);
    return undefined;
  }
  if (copied === OVER_BUDGET || acc.budget.left < 0) return OVERSIZED_RESULT;
  if (copied === UNSUPPORTED) return UNSUPPORTED_RESULT;
  acc.data[fieldPath] = copied;
  return undefined;
}

function finalizeUpdateOp(
  acc: AdminUpdateAccumulator,
  path: string,
): SessionCopyResult<ObservedFirestoreSessionOp> {
  if (acc.budget.left < 0) return OVERSIZED_RESULT;
  const op: { kind: 'update'; path: string; data: Record<string, unknown>; deleteFields?: string[] } = {
    kind: 'update',
    path,
    data: acc.data,
  };
  if (acc.deleteFields.length > 0) op.deleteFields = acc.deleteFields;
  return { ok: true, value: op };
}

function adminMergeFieldsOp(
  path: string,
  rawData: unknown,
  mergeFields: readonly unknown[],
  budget: SessionBudget,
): SessionCopyResult<ObservedFirestoreSessionOp> {
  if (!isPlainObject(rawData)) return UNSUPPORTED_RESULT;
  const acc = createUpdateAccumulator(budget);
  if (!chargeContainer(budget)) return OVERSIZED_RESULT;
  for (const rawField of mergeFields) {
    const fieldPath = adminFieldPathString(rawField);
    if (fieldPath === undefined) return UNSUPPORTED_RESULT;
    const lookup = readNestedAtFieldPath(rawData, fieldPath);
    if (!lookup.found) continue;
    const stop = addUpdateField(acc, fieldPath, lookup.value);
    if (stop !== undefined) return stop;
  }
  return finalizeUpdateOp(acc, path);
}

/** Bounded `set` or `update` op for `DocumentReference.set` / `WriteBatch.set` / `Transaction.set`. */
export function adminSetDocOp(
  docPath: string,
  rawData: unknown,
  rawOptions: unknown,
  budget: SessionBudget = itemBudget(),
): SessionCopyResult<ObservedFirestoreSessionOp> {
  if (!isValidDocPath(docPath)) return UNSUPPORTED_RESULT;
  const path = normalizeDocPath(docPath);
  const mergeFields = mergeFieldsOf(rawOptions);
  if (mergeFields !== undefined) return adminMergeFieldsOp(path, rawData, mergeFields, budget);

  const isMerge = isObject(rawOptions) && Reflect.get(rawOptions, 'merge') === true;
  const fields = adminWriteFields(rawData, isMerge, budget);
  if (!fields.ok) return fields;
  const op: { kind: 'set'; path: string; data: Record<string, unknown>; merge?: boolean; deleteFields?: string[] } = {
    kind: 'set',
    path,
    data: fields.value.data,
  };
  if (isMerge) op.merge = true;
  if (fields.value.deleteFields !== undefined) op.deleteFields = fields.value.deleteFields;
  return { ok: true, value: op };
}

function isOptionalPrecondition(arg: unknown): boolean {
  return arg === undefined || isPlainObject(arg);
}

function startsVariadicUpdate(firstArg: unknown): boolean {
  return typeof firstArg === 'string' || isAdminFieldPathObject(firstArg);
}

/** Bounded `update` op for `DocumentReference.update` / `WriteBatch.update` / `Transaction.update`. */
export function adminUpdateDocOp(
  docPath: string,
  restArgs: readonly unknown[],
  budget: SessionBudget = itemBudget(),
): SessionCopyResult<ObservedFirestoreSessionOp> {
  if (!isValidDocPath(docPath) || restArgs.length === 0) return UNSUPPORTED_RESULT;
  const path = normalizeDocPath(docPath);
  const acc = createUpdateAccumulator(budget);
  if (!chargeContainer(budget)) return OVERSIZED_RESULT;

  if (startsVariadicUpdate(restArgs[0])) {
    if (restArgs.length < 2) return UNSUPPORTED_RESULT;
    const hasOddTrailingArg = restArgs.length % 2 === 1;
    if (hasOddTrailingArg && !isPlainObject(restArgs[restArgs.length - 1])) return UNSUPPORTED_RESULT;
    for (let i = 0; i + 1 < restArgs.length; i += 2) {
      const fieldPath = adminFieldPathString(restArgs[i]);
      if (fieldPath === undefined) return UNSUPPORTED_RESULT;
      const stop = addUpdateField(acc, fieldPath, restArgs[i + 1]);
      if (stop !== undefined) return stop;
    }
    return finalizeUpdateOp(acc, path);
  }

  const payload = restArgs[0];
  const hasValidPreconditionSlot = restArgs.length === 1 || (restArgs.length === 2 && isOptionalPrecondition(restArgs[1]));
  if (!isPlainObject(payload) || !hasValidPreconditionSlot) return UNSUPPORTED_RESULT;
  for (const [rawKey, rawValue] of Object.entries(payload)) {
    const fieldPath = adminFieldPathString(rawKey);
    if (fieldPath === undefined) return UNSUPPORTED_RESULT;
    const stop = addUpdateField(acc, fieldPath, rawValue);
    if (stop !== undefined) return stop;
  }
  return finalizeUpdateOp(acc, path);
}
