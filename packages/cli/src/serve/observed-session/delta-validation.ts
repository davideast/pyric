/**
 * Validation of the untrusted `sessionData` a `@pyric/live` client sends on an
 * observe frame. Every violation throws a `SessionDeltaRejected` naming the
 * field and why the host skips the delta: `oversized` when it breaks a size
 * bound, `unsupported` for any other shape the host does not keep.
 */
import { byteLengthOf, FORBIDDEN_KEYS, isPlainObject } from './json-values.js';
import { readStorageOp } from './storage-delta-validation.js';
import type {
  ObservedFirestoreSessionOp,
  ObservedRtdbSessionOp,
  ObservedSessionDelta,
  ObservedSessionSkipCounts,
  ObservedStorageSessionOp,
} from './wire.js';

/** The host's per-item cap; `@pyric/live` budgets half of it so an honest client never meets it. */
export const MAX_SINGLE_ITEM_BYTES = 512 * 1024;
const MAX_SESSION_OPS_PER_DELTA = 500;
/** The host's per-delta cap; `@pyric/live` budgets half of it, in the same UTF-8 bytes. */
const MAX_SESSION_DELTA_BYTES = 1024 * 1024;
const MAX_SESSION_VALUE_DEPTH = 20;
const MAX_FIRESTORE_PATH_SEGMENTS = 32;
export const MAX_PATH_LENGTH = 1024;
const MAX_DELETE_FIELDS = 256;
const MAX_SKIP_COUNT = 1_000_000;

export const RTDB_FORBIDDEN_SEGMENT = /[.#$[\]]/;

/** Why the host skipped a delta, as the snapshot's `skips` counts it. */
export type SessionDeltaSkipReason = 'oversized' | 'unsupported';

/** A delta the host does not keep: the call it rode on still counts, only its data is skipped. */
export class SessionDeltaRejected extends Error {
  readonly reason: SessionDeltaSkipReason;

  constructor(reason: SessionDeltaSkipReason, message: string) {
    super(message);
    this.name = 'SessionDeltaRejected';
    this.reason = reason;
  }
}

function unsupported(message: string): SessionDeltaRejected {
  return new SessionDeltaRejected('unsupported', message);
}

function oversized(message: string): SessionDeltaRejected {
  return new SessionDeltaRejected('oversized', message);
}

function assertSafeKey(key: string, label: string): void {
  if (FORBIDDEN_KEYS.has(key)) throw unsupported(`Invalid ${label}: forbidden key '${key}'.`);
}

function hasPrototypeKey(value: Record<string, unknown>): boolean {
  return [...FORBIDDEN_KEYS].some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function sanitizeJsonValue(value: unknown, label: string, depth = 0): unknown {
  if (depth > MAX_SESSION_VALUE_DEPTH) {
    throw unsupported(`Invalid ${label}: value is nested deeper than ${MAX_SESSION_VALUE_DEPTH} levels.`);
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw unsupported(`Invalid ${label}: non-finite number.`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, idx) => sanitizeJsonValue(item, `${label}[${idx}]`, depth + 1));
  }
  if (isPlainObject(value)) {
    if (hasPrototypeKey(value)) throw unsupported(`Invalid ${label}: forbidden prototype key.`);
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      assertSafeKey(key, label);
      if (entry === undefined) continue;
      out[key] = sanitizeJsonValue(entry, `${label}.${key}`, depth + 1);
    }
    return out;
  }
  throw unsupported(`Invalid ${label}: unsupported value type.`);
}

function isBadSegment(seg: string): boolean {
  return seg.length === 0 || seg === '.' || seg === '..' || FORBIDDEN_KEYS.has(seg);
}

function readFirestoreDocPath(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PATH_LENGTH) {
    throw unsupported(`Invalid ${label}: expected non-empty document path.`);
  }
  let trimmed = raw;
  if (raw.startsWith('/')) trimmed = raw.slice(1);
  const segments = trimmed.split('/');
  const isDocumentPath = segments.length >= 2 && segments.length % 2 === 0;
  const isValid = isDocumentPath && segments.length <= MAX_FIRESTORE_PATH_SEGMENTS && !segments.some(isBadSegment);
  if (!isValid) throw unsupported(`Invalid ${label}: '${raw}' is not a valid Firestore document path.`);
  return segments.join('/');
}

function isBadFieldPath(fieldPath: string): boolean {
  return fieldPath.split('.').some((part) => part.length === 0 || FORBIDDEN_KEYS.has(part));
}

/** Field paths to delete, or undefined when there are none. */
function readDeleteFields(raw: unknown, label: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > MAX_DELETE_FIELDS) {
    throw unsupported(`Invalid ${label}: expected an array of up to ${MAX_DELETE_FIELDS} field paths.`);
  }
  const fields = raw.map((entry, idx) => {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 512) {
      throw unsupported(`Invalid ${label}[${idx}]: expected non-empty field path.`);
    }
    if (isBadFieldPath(entry)) throw unsupported(`Invalid ${label}[${idx}]: invalid field path '${entry}'.`);
    return entry;
  });
  if (fields.length === 0) return undefined;
  return fields;
}

function readRtdbInstance(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 256 || FORBIDDEN_KEYS.has(raw)) {
    throw unsupported(`Invalid ${label}: expected non-empty RTDB instance name.`);
  }
  return raw;
}

function readRtdbPath(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || raw.length > MAX_PATH_LENGTH) {
    throw unsupported(`Invalid ${label}: expected RTDB path string.`);
  }
  const segments = raw.split('/').filter((seg) => seg.length > 0);
  for (const seg of segments) {
    assertSafeKey(seg, label);
    if (RTDB_FORBIDDEN_SEGMENT.test(seg)) {
      throw unsupported(`Invalid ${label}: RTDB path segment '${seg}' contains forbidden characters.`);
    }
  }
  if (segments.length === 0) return '/';
  return `/${segments.join('/')}`;
}

function readFirestoreData(raw: Record<string, unknown>, label: string): Record<string, unknown> {
  if (!isPlainObject(raw.data)) throw unsupported(`Invalid ${label}.data: expected plain object.`);
  return sanitizeJsonValue(raw.data, `${label}.data`) as Record<string, unknown>;
}

function readFirestoreSet(raw: Record<string, unknown>, label: string, path: string): ObservedFirestoreSessionOp {
  const data = readFirestoreData(raw, label);
  if (raw.merge !== undefined && typeof raw.merge !== 'boolean') {
    throw unsupported(`Invalid ${label}.merge: expected boolean.`);
  }
  const op: { kind: 'set'; path: string; data: Record<string, unknown>; merge?: boolean; deleteFields?: string[] } = {
    kind: 'set',
    path,
    data,
  };
  if (raw.merge === true) op.merge = true;
  const deleteFields = readDeleteFields(raw.deleteFields, `${label}.deleteFields`);
  if (deleteFields !== undefined) op.deleteFields = deleteFields;
  return op;
}

function readFirestoreUpdate(raw: Record<string, unknown>, label: string, path: string): ObservedFirestoreSessionOp {
  const data = readFirestoreData(raw, label);
  for (const fieldPath of Object.keys(data)) {
    if (isBadFieldPath(fieldPath)) throw unsupported(`Invalid ${label}.data: invalid field path '${fieldPath}'.`);
  }
  const op: { kind: 'update'; path: string; data: Record<string, unknown>; deleteFields?: string[] } = {
    kind: 'update',
    path,
    data,
  };
  const deleteFields = readDeleteFields(raw.deleteFields, `${label}.deleteFields`);
  if (deleteFields !== undefined) op.deleteFields = deleteFields;
  return op;
}

function readFirestoreOp(raw: unknown, index: number): ObservedFirestoreSessionOp {
  const label = `sessionData.firestore[${index}]`;
  if (!isPlainObject(raw)) throw unsupported(`Invalid ${label}: expected object.`);
  const path = readFirestoreDocPath(raw.path, `${label}.path`);
  switch (raw.kind) {
    case 'delete':
      return { kind: 'delete', path };
    case 'set':
      return readFirestoreSet(raw, label, path);
    case 'update':
      return readFirestoreUpdate(raw, label, path);
    default:
      throw unsupported(`Invalid ${label}.kind: expected 'set', 'update', or 'delete'.`);
  }
}

/** An RTDB update's children keyed by their normalized relative path. */
function readRtdbPatch(raw: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(raw)) throw unsupported(`Invalid ${label}.value: expected plain object.`);
  const sanitized = sanitizeJsonValue(raw, `${label}.value`) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const [relKey, entry] of Object.entries(sanitized)) {
    const normalizedRel = readRtdbPath(relKey, `${label}.value[${relKey}]`);
    if (normalizedRel === '/') throw unsupported(`Invalid ${label}.value: update key cannot be empty.`);
    patch[normalizedRel.slice(1)] = entry;
  }
  return patch;
}

function readRtdbOp(raw: unknown, index: number): ObservedRtdbSessionOp {
  const label = `sessionData.rtdb[${index}]`;
  if (!isPlainObject(raw)) throw unsupported(`Invalid ${label}: expected object.`);
  const instance = readRtdbInstance(raw.instance, `${label}.instance`);
  const path = readRtdbPath(raw.path, `${label}.path`);
  switch (raw.kind) {
    case 'remove':
      return { kind: 'remove', instance, path };
    case 'set':
      if (!('value' in raw)) throw unsupported(`Invalid ${label}.value: missing value.`);
      return { kind: 'set', instance, path, value: sanitizeJsonValue(raw.value, `${label}.value`) };
    case 'update':
      return { kind: 'update', instance, path, value: readRtdbPatch(raw.value, label) };
    default:
      throw unsupported(`Invalid ${label}.kind: expected 'set', 'update', or 'remove'.`);
  }
}

/** A positive skip count, or undefined when it is absent or zero. */
function readSkipCountField(raw: unknown, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const isCount = typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= MAX_SKIP_COUNT;
  if (!isCount) throw unsupported(`Invalid ${label}: expected non-negative integer.`);
  if (raw === 0) return undefined;
  return raw;
}

const SKIP_COUNT_KEYS = ['oversized', 'unsupported', 'truncated'] as const;

function readObservedSkipCounts(raw: unknown): ObservedSessionSkipCounts | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) throw unsupported('Invalid sessionData.skipped: expected plain object.');
  for (const key of Object.keys(raw)) {
    const isKnown = (SKIP_COUNT_KEYS as readonly string[]).includes(key);
    if (!isKnown) throw unsupported(`Invalid sessionData.skipped.${key}: unexpected field.`);
  }
  const counts: { oversized?: number; unsupported?: number; truncated?: number } = {};
  for (const key of SKIP_COUNT_KEYS) {
    const count = readSkipCountField(raw[key], `sessionData.skipped.${key}`);
    if (count !== undefined) counts[key] = count;
  }
  if (Object.keys(counts).length === 0) return undefined;
  return counts;
}

/** The ops of one service, or undefined when the delta has none; counts them against the per-delta bound. */
function readOps<T>(raw: unknown, service: string, opsSoFar: number, read: (entry: unknown, idx: number) => T): T[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw unsupported(`Invalid sessionData.${service}: expected array.`);
  if (opsSoFar + raw.length > MAX_SESSION_OPS_PER_DELTA) {
    throw oversized(`Invalid sessionData: more than ${MAX_SESSION_OPS_PER_DELTA} operations.`);
  }
  if (raw.length === 0) return undefined;
  return raw.map(read);
}

/**
 * Validate and normalize an untrusted `sessionData` payload from an `observe`
 * frame. Throws a `SessionDeltaRejected` naming the invalid field and the skip
 * reason on any violation.
 */
export function readObservedSessionDelta(raw: unknown): ObservedSessionDelta {
  if (!isPlainObject(raw)) throw unsupported('Invalid sessionData: expected plain object.');
  for (const key of Object.keys(raw)) {
    const isKnown = key === 'firestore' || key === 'rtdb' || key === 'storage' || key === 'skipped';
    if (!isKnown) throw unsupported(`Invalid sessionData.${key}: unexpected field.`);
  }
  if (byteLengthOf(raw) > MAX_SESSION_DELTA_BYTES) {
    throw oversized(`Invalid sessionData: payload is larger than ${MAX_SESSION_DELTA_BYTES} bytes.`);
  }
  const delta: {
    firestore?: ObservedFirestoreSessionOp[];
    rtdb?: ObservedRtdbSessionOp[];
    storage?: ObservedStorageSessionOp[];
    skipped?: ObservedSessionSkipCounts;
  } = {};
  const firestore = readOps(raw.firestore, 'firestore', 0, readFirestoreOp);
  const firestoreCount = firestore?.length ?? 0;
  if (firestore !== undefined) delta.firestore = firestore;
  const rtdb = readOps(raw.rtdb, 'rtdb', firestoreCount, readRtdbOp);
  const rtdbCount = rtdb?.length ?? 0;
  if (rtdb !== undefined) delta.rtdb = rtdb;
  const storage = readOps(raw.storage, 'storage', firestoreCount + rtdbCount, readStorageOp);
  if (storage !== undefined) delta.storage = storage;
  const skipped = readObservedSkipCounts(raw.skipped);
  if (skipped !== undefined) delta.skipped = skipped;
  return delta;
}

/** Why a validation error skips a delta: its own reason, or `unsupported` for anything else thrown. */
export function skipReasonOf(error: unknown): SessionDeltaSkipReason {
  if (error instanceof SessionDeltaRejected) return error.reason;
  return 'unsupported';
}
