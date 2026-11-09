/**
 * Session-scoped data capture for the Admin Realtime Database row
 * (`@firebase/database-compat/standalone`), producing bounded
 * `ObservedSessionDelta` sidecars (`<= 256 KiB` per value) from successful
 * Admin reads (`Query.get`, `Query.once`), listeners (`Query.on`), writes
 * (`Reference.set`, `setWithPriority`, `update`, `remove`, `push`), and
 * committed `Reference.transaction` calls while keeping `LiveCallRecord`
 * completely free of data values.
 */
import { isObject, pathOf, queryIdOf, UNREAD_INSTANCE } from '../database.js';
import { isPlainObject } from '../json-copy.js';
import type { CallContext, ObservedSite, ResultReading } from '../observe.js';
import {
  chargeContainer,
  chargeScalar,
  chargeString,
  MAX_SESSION_ITEM_BYTES,
  type SessionBudget,
} from '../session-budget.js';
import {
  skipDeltaOf,
  type ObservedRtdbSessionOp,
  type ObservedSessionDelta,
} from '../session-data.js';

const MAX_RTDB_SESSION_DEPTH = 20;
const MAX_RTDB_SESSION_PATH_LENGTH = 1024;
const INVALID_RTDB_SESSION: unique symbol = Symbol('admin-invalid-rtdb-session');
const OVERSIZED_RTDB_SESSION: unique symbol = Symbol('admin-oversized-rtdb-session');
const FORBIDDEN_RTDB_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const FORBIDDEN_RTDB_PATH_CHARS = /[.#$[\]]/;
const ADMIN_RTDB_WRITES: ReadonlySet<string> = new Set([
  'Reference.remove',
  'Reference.set',
  'Reference.setWithPriority',
  'Reference.update',
  'Reference.push',
]);

type Fields = Record<string, unknown>;

interface AdminOnceSubject {
  readonly kind: 'admin-rtdb-once';
  readonly eventType: string;
}

function isForbiddenRtdbKey(key: string): boolean {
  return FORBIDDEN_RTDB_KEYS.has(key) || FORBIDDEN_RTDB_PATH_CHARS.test(key);
}

function namesRtdbSessionPath(path: string | undefined): path is string {
  if (typeof path !== 'string' || path.length > MAX_RTDB_SESSION_PATH_LENGTH) return false;
  const segments = path.split('/').filter((seg) => seg.length > 0);
  return segments.every((seg) => !isForbiddenRtdbKey(seg));
}

function copyRtdbSessionValue(
  value: unknown,
  depth: number,
  budget: SessionBudget,
): unknown {
  if (value === null || typeof value === 'boolean') {
    if (!chargeScalar(budget, value)) return OVERSIZED_RTDB_SESSION;
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return INVALID_RTDB_SESSION;
    if (!chargeScalar(budget, value)) return OVERSIZED_RTDB_SESSION;
    return value;
  }
  if (typeof value === 'string') {
    if (!chargeString(budget, value)) return OVERSIZED_RTDB_SESSION;
    return value;
  }
  if (depth >= MAX_RTDB_SESSION_DEPTH) return INVALID_RTDB_SESSION;
  if (Array.isArray(value)) {
    if (!chargeContainer(budget)) return OVERSIZED_RTDB_SESSION;
    return copyRtdbItems(value, depth, budget);
  }
  if (!isPlainObject(value)) return INVALID_RTDB_SESSION;
  if (!chargeContainer(budget)) return OVERSIZED_RTDB_SESSION;
  return copyRtdbEntries(value, depth, budget);
}

function copyRtdbItems(
  items: readonly unknown[],
  depth: number,
  budget: SessionBudget,
): unknown {
  const out: unknown[] = [];
  for (const item of items) {
    if (item === undefined) {
      out.push(null);
      continue;
    }
    const copied = copyRtdbSessionValue(item, depth + 1, budget);
    if (copied === OVERSIZED_RTDB_SESSION || budget.left < 0) return OVERSIZED_RTDB_SESSION;
    if (copied === INVALID_RTDB_SESSION) return INVALID_RTDB_SESSION;
    out.push(copied);
  }
  return out;
}

function copyRtdbEntries(
  fields: Fields,
  depth: number,
  budget: SessionBudget,
): unknown {
  const out: Fields = {};
  for (const [key, entry] of Object.entries(fields)) {
    if (isForbiddenRtdbKey(key)) return INVALID_RTDB_SESSION;
    if (entry === undefined) continue;
    if (!chargeString(budget, key)) return OVERSIZED_RTDB_SESSION;
    const copied = copyRtdbSessionValue(entry, depth + 1, budget);
    if (copied === OVERSIZED_RTDB_SESSION) return OVERSIZED_RTDB_SESSION;
    if (copied === INVALID_RTDB_SESSION) return INVALID_RTDB_SESSION;
    out[key] = copied;
  }
  return out;
}

function copiedValue(
  value: unknown,
): { value: unknown } | { skipped: ObservedSessionDelta } {
  const copied = copyRtdbSessionValue(value, 0, { left: MAX_SESSION_ITEM_BYTES });
  if (copied === OVERSIZED_RTDB_SESSION) return { skipped: skipDeltaOf('oversized') };
  if (copied === INVALID_RTDB_SESSION) return { skipped: skipDeltaOf('unsupported') };
  return { value: copied };
}

function opDelta(op: ObservedRtdbSessionOp): ObservedSessionDelta {
  return { rtdb: [op] };
}

function updateDelta(rawPatch: unknown, instance: string, path: string): ObservedSessionDelta | undefined {
  if (!isPlainObject(rawPatch)) return skipDeltaOf('unsupported');
  const budget: SessionBudget = { left: MAX_SESSION_ITEM_BYTES };
  const patch: Fields = {};
  let hasEntry = false;
  if (!chargeContainer(budget)) return skipDeltaOf('oversized');
  for (const [relKey, rawVal] of Object.entries(rawPatch)) {
    if (rawVal === undefined) continue;
    const relSegments = relKey.split('/').filter((seg) => seg.length > 0);
    if (relSegments.length === 0 || relSegments.some(isForbiddenRtdbKey)) return skipDeltaOf('unsupported');
    if (!chargeString(budget, relKey)) return skipDeltaOf('oversized');
    const copied = copyRtdbSessionValue(rawVal, 0, budget);
    if (copied === OVERSIZED_RTDB_SESSION) return skipDeltaOf('oversized');
    if (copied === INVALID_RTDB_SESSION) return skipDeltaOf('unsupported');
    patch[relSegments.join('/')] = copied;
    hasEntry = true;
  }
  if (hasEntry) return opDelta({ kind: 'update', instance, path, value: patch });
  return undefined;
}

function compatPathOf(target: unknown): string | undefined {
  if (!isObject(target)) return undefined;
  const fromDelegate = pathOf(target._delegate);
  if (namesRtdbSessionPath(fromDelegate)) return fromDelegate;
  const direct = pathOf(target);
  if (namesRtdbSessionPath(direct)) return direct;
  return undefined;
}

function childPathUnder(parentPath: string | undefined, childKey: unknown): string | undefined {
  if (typeof childKey !== 'string' || childKey.length === 0) return undefined;
  if (!namesRtdbSessionPath(parentPath)) return undefined;
  let candidate = `${parentPath}/${childKey}`;
  if (parentPath === '/') candidate = `/${childKey}`;
  if (!namesRtdbSessionPath(candidate)) return undefined;
  return candidate;
}

function pushChildPath(parentPath: string | undefined, childRef: unknown): string | undefined {
  const fromRef = compatPathOf(childRef);
  if (fromRef !== undefined) return fromRef;
  if (isObject(childRef)) return childPathUnder(parentPath, childRef.key);
  return undefined;
}

/** Session context extracted before an Admin RTDB method executes. */
export function adminDatabaseSessionContext(
  name: string,
  args: readonly unknown[],
  instance: string,
  path: string | undefined,
): Pick<CallContext, 'subject' | 'sessionData'> {
  if (name === 'Query.once') {
    let eventType = 'value';
    if (typeof args[0] === 'string') eventType = args[0];
    const subject: AdminOnceSubject = { kind: 'admin-rtdb-once', eventType };
    return { subject };
  }
  if (!namesRtdbSessionPath(path)) {
    if (ADMIN_RTDB_WRITES.has(name)) return { sessionData: skipDeltaOf('unsupported') };
    return {};
  }
  if (name === 'Reference.remove') {
    return { sessionData: opDelta({ kind: 'remove', instance, path }) };
  }
  if (name === 'Reference.set' || name === 'Reference.setWithPriority') {
    const copied = copiedValue(args[0]);
    if ('skipped' in copied) return { sessionData: copied.skipped };
    return { sessionData: opDelta({ kind: 'set', instance, path, value: copied.value }) };
  }
  if (name === 'Reference.update') {
    const sessionData = updateDelta(args[0], instance, path);
    if (sessionData === undefined) return {};
    return { sessionData };
  }
  if (name === 'Reference.push') {
    const childPath = pushChildPath(path, args[0]);
    if (childPath === undefined) return { sessionData: skipDeltaOf('unsupported') };
    const copied = copiedValue(args[1]);
    if ('skipped' in copied) return { sessionData: copied.skipped };
    return { sessionData: opDelta({ kind: 'set', instance, path: childPath, value: copied.value }) };
  }
  return {};
}

function isSnapshot(value: unknown): value is Fields & { val: (...args: unknown[]) => unknown } {
  return isObject(value) && typeof value.val === 'function';
}

function snapshotPathOf(snap: Fields, fallbackPath?: string): string | undefined {
  const fromRef = compatPathOf(snap.ref);
  if (fromRef !== undefined) return fromRef;
  if (isObject(snap._delegate)) {
    const fromSnapDelegate = pathOf(snap._delegate.ref);
    if (namesRtdbSessionPath(fromSnapDelegate)) return fromSnapDelegate;
  }
  if (namesRtdbSessionPath(fallbackPath)) return fallbackPath;
  return undefined;
}

function isFilteredSnap(site: ObservedSite, snap: Fields): boolean {
  if (site.rtdbFilteredQuery === true) return true;
  if (isObject(snap._delegate) && queryIdOf(snap._delegate._query) !== 'default') return true;
  return queryIdOf(snap._query) !== 'default';
}

function valueSnapshotDelta(
  site: ObservedSite,
  snap: Fields & { val: (...args: unknown[]) => unknown },
  forceUnfiltered = false,
): ObservedSessionDelta | undefined {
  const instance = site.instance ?? UNREAD_INSTANCE;
  const path = snapshotPathOf(snap, site.path);
  if (path === undefined) return skipDeltaOf('unsupported');
  const copied = copiedValue(Reflect.apply(snap.val, snap, []));
  if ('skipped' in copied) return copied.skipped;
  if (forceUnfiltered || !isFilteredSnap(site, snap)) {
    return opDelta({ kind: 'set', instance, path, value: copied.value });
  }
  if (copied.value === null) return undefined;
  if (!isPlainObject(copied.value)) return skipDeltaOf('unsupported');
  if (Object.keys(copied.value).length === 0) return undefined;
  return opDelta({ kind: 'update', instance, path, value: copied.value });
}

function childEventDelta(
  site: ObservedSite,
  eventType: string,
  snap: Fields & { val: (...args: unknown[]) => unknown },
): ObservedSessionDelta | undefined {
  const instance = site.instance ?? UNREAD_INSTANCE;
  let childPath = snapshotPathOf(snap, undefined);
  if (childPath === undefined) childPath = childPathUnder(site.path, snap.key);
  if (childPath === undefined) return skipDeltaOf('unsupported');
  if (eventType === 'child_removed') {
    if (isFilteredSnap(site, snap)) return undefined;
    return opDelta({ kind: 'remove', instance, path: childPath });
  }
  const copied = copiedValue(Reflect.apply(snap.val, snap, []));
  if ('skipped' in copied) return copied.skipped;
  return opDelta({ kind: 'set', instance, path: childPath, value: copied.value });
}

function isChildEventType(eventType: string): boolean {
  return (
    eventType === 'child_added' ||
    eventType === 'child_changed' ||
    eventType === 'child_removed' ||
    eventType === 'child_moved'
  );
}

function onceEventTypeOf(subject: unknown): string {
  if (isObject(subject) && subject.kind === 'admin-rtdb-once' && typeof subject.eventType === 'string') {
    return subject.eventType;
  }
  return 'value';
}

/** Extracts bounded session-observed RTDB values from resolved `Query.get`, `Query.once`, and `Reference.transaction` calls. */
export function adminDatabaseResult(site: ObservedSite, value: unknown): ResultReading {
  if (site.name === 'Query.get' && isSnapshot(value)) {
    const sessionData = valueSnapshotDelta(site, value);
    if (sessionData === undefined) return {};
    return { sessionData };
  }
  if (site.name === 'Query.once' && isSnapshot(value)) {
    const eventType = onceEventTypeOf(site.subject);
    let sessionData: ObservedSessionDelta | undefined;
    if (isChildEventType(eventType)) sessionData = childEventDelta(site, eventType, value);
    else sessionData = valueSnapshotDelta(site, value);
    if (sessionData === undefined) return {};
    return { sessionData };
  }
  if (site.name === 'Reference.transaction' && isObject(value) && value.committed === true) {
    const snap = value.snapshot;
    if (!isSnapshot(snap)) return {};
    const sessionData = valueSnapshotDelta(site, snap, true);
    if (sessionData === undefined) return {};
    return { sessionData };
  }
  return {};
}

/** Extracts bounded session-observed RTDB values from `Query.on` listener deliveries. */
export function adminDatabaseDelivery(
  site: ObservedSite,
  eventType: string,
  value: unknown,
): ObservedSessionDelta | undefined {
  if (!isSnapshot(value)) return undefined;
  if (isChildEventType(eventType)) return childEventDelta(site, eventType, value);
  if (eventType === 'value') return valueSnapshotDelta(site, value);
  return undefined;
}
