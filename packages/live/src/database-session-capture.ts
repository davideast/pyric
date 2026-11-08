/**
 * What a Realtime Database client-SDK call adds to the live host's session
 * data: a bounded JSON copy of each value a successful call observed, as one
 * `ObservedSessionDelta` per call.
 *
 * - A write (`set`, `setWithPriority`, `update`, `remove`) names its op in
 *   its context, with server-value sentinels (`.sv`) left out; a `push`
 *   holds its value until it resolves with the new child's path.
 * - A bare `get` or `onValue` sets the value at its path; a filtered query
 *   updates just the children it returned, so siblings it filtered out stay.
 * - A child listener sets (`onChildAdded`, `onChildChanged`) or removes
 *   (`onChildRemoved`) its child, at `rooms/{id}/{childKey}`.
 *
 * Each value spends at most 256 KiB, in UTF-8 bytes of its JSON
 * (`session-budget.ts`); a larger one counts `oversized`, and one that holds
 * anything but JSON, or a key or path a host refuses, `unsupported`. A
 * `runTransaction` counts `unsupported` and an OnDisconnect write names
 * nothing: neither is a value production stored when the call settled.
 */
import type { CallContext, ObservedSite, ResultReading } from './observe.js';
import { isObject, pathOf, queryIdOf, UNREAD_INSTANCE } from './database.js';
import { isPlainObject } from './json-copy.js';
import { chargeContainer, chargeScalar, chargeString, MAX_SESSION_ITEM_BYTES, type SessionBudget } from './session-budget.js';
import { skipDeltaOf, type ObservedRtdbSessionOp, type ObservedSessionDelta } from './session-data.js';

const MAX_RTDB_SESSION_DEPTH = 20;
const MAX_RTDB_SESSION_PATH_LENGTH = 1024;
const INVALID_RTDB_SESSION: unique symbol = Symbol('invalid-rtdb-session');
const OVERSIZED_RTDB_SESSION: unique symbol = Symbol('oversized-rtdb-session');
const OMIT_RTDB_SENTINEL: unique symbol = Symbol('omit-rtdb-sentinel');
const FORBIDDEN_RTDB_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const FORBIDDEN_RTDB_PATH_CHARS = /[.#$[\]]/;
const RTDB_WRITES: ReadonlySet<string> = new Set(['remove', 'set', 'setWithPriority', 'update', 'push']);

type Fields = Record<string, unknown>;

function isForbiddenRtdbKey(key: string): boolean {
  return FORBIDDEN_RTDB_KEYS.has(key) || FORBIDDEN_RTDB_PATH_CHARS.test(key);
}

function isValidRtdbSessionPath(path: string | undefined): path is string {
  if (typeof path !== 'string' || path.length > MAX_RTDB_SESSION_PATH_LENGTH) return false;
  const segments = path.split('/').filter((seg) => seg.length > 0);
  return segments.every((seg) => !isForbiddenRtdbKey(seg));
}

function copyRtdbSessionValue(value: unknown, depth: number, budget: SessionBudget, stripSentinels: boolean): unknown {
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
    return copyRtdbItems(value, depth, budget, stripSentinels);
  }
  if (!isPlainObject(value)) return INVALID_RTDB_SESSION;
  if (stripSentinels && Object.prototype.hasOwnProperty.call(value, '.sv')) return OMIT_RTDB_SENTINEL;
  if (!chargeContainer(budget)) return OVERSIZED_RTDB_SESSION;
  return copyRtdbEntries(value, depth, budget, stripSentinels);
}

function copyRtdbItems(items: readonly unknown[], depth: number, budget: SessionBudget, stripSentinels: boolean): unknown {
  const out: unknown[] = [];
  for (const item of items) {
    if (item === undefined) {
      out.push(null);
      continue;
    }
    const copied = copyRtdbSessionValue(item, depth + 1, budget, stripSentinels);
    if (copied === OMIT_RTDB_SENTINEL) {
      out.push(null);
      continue;
    }
    if (copied === OVERSIZED_RTDB_SESSION || budget.left < 0) return OVERSIZED_RTDB_SESSION;
    if (copied === INVALID_RTDB_SESSION) return INVALID_RTDB_SESSION;
    out.push(copied);
  }
  return out;
}

function copyRtdbEntries(fields: Fields, depth: number, budget: SessionBudget, stripSentinels: boolean): unknown {
  const out: Fields = {};
  for (const [key, entry] of Object.entries(fields)) {
    if (isForbiddenRtdbKey(key)) return INVALID_RTDB_SESSION;
    if (entry === undefined) continue;
    if (!chargeString(budget, key)) return OVERSIZED_RTDB_SESSION;
    const copied = copyRtdbSessionValue(entry, depth + 1, budget, stripSentinels);
    if (copied === OMIT_RTDB_SENTINEL) continue;
    if (copied === OVERSIZED_RTDB_SESSION) return OVERSIZED_RTDB_SESSION;
    if (copied === INVALID_RTDB_SESSION) return INVALID_RTDB_SESSION;
    out[key] = copied;
  }
  return out;
}

/** A copy of one whole value under a fresh item budget, or the skip delta that left it out. */
function copiedValue(value: unknown, stripSentinels: boolean): { value: unknown } | { skipped: ObservedSessionDelta } {
  const copied = copyRtdbSessionValue(value, 0, { left: MAX_SESSION_ITEM_BYTES }, stripSentinels);
  if (copied === OVERSIZED_RTDB_SESSION) return { skipped: skipDeltaOf('oversized') };
  if (copied === INVALID_RTDB_SESSION || copied === OMIT_RTDB_SENTINEL) return { skipped: skipDeltaOf('unsupported') };
  return { value: copied };
}

function opDelta(op: ObservedRtdbSessionOp): ObservedSessionDelta {
  return { rtdb: [op] };
}

/** An `update` patch's op: each defined child copied under its relative path, sentinels left out. */
function updateDelta(rawPatch: unknown, instance: string, path: string): ObservedSessionDelta | undefined {
  if (!isPlainObject(rawPatch)) return skipDeltaOf('unsupported');
  const budget: SessionBudget = { left: MAX_SESSION_ITEM_BYTES };
  const patch: Fields = {};
  let hasEntry = false;
  let hadDefinedEntry = false;
  if (!chargeContainer(budget)) return skipDeltaOf('oversized');
  for (const [relKey, rawVal] of Object.entries(rawPatch)) {
    if (rawVal === undefined) continue;
    hadDefinedEntry = true;
    const relSegments = relKey.split('/').filter((s) => s.length > 0);
    if (relSegments.length === 0 || relSegments.some(isForbiddenRtdbKey)) return skipDeltaOf('unsupported');
    if (!chargeString(budget, relKey)) return skipDeltaOf('oversized');
    const copied = copyRtdbSessionValue(rawVal, 0, budget, true);
    if (copied === OMIT_RTDB_SENTINEL) continue;
    if (copied === OVERSIZED_RTDB_SESSION) return skipDeltaOf('oversized');
    if (copied === INVALID_RTDB_SESSION) return skipDeltaOf('unsupported');
    patch[relSegments.join('/')] = copied;
    hasEntry = true;
  }
  if (hasEntry) return opDelta({ kind: 'update', instance, path, value: patch });
  if (hadDefinedEntry) return skipDeltaOf('unsupported');
  return undefined;
}

/**
 * The session part of a write's context: its op, the skip that left it out,
 * or, for a `push`, the value awaiting the new child's path.
 */
export function databaseWriteSession(
  name: string,
  args: readonly unknown[],
  instance: string,
  path: string | undefined,
): Pick<CallContext, 'sessionData' | 'pendingPushValue'> {
  if (name === 'runTransaction') return { sessionData: skipDeltaOf('unsupported') };
  if (!isValidRtdbSessionPath(path)) {
    if (RTDB_WRITES.has(name)) return { sessionData: skipDeltaOf('unsupported') };
    return {};
  }
  if (name === 'remove') return { sessionData: opDelta({ kind: 'remove', instance, path }) };
  if (name === 'set' || name === 'setWithPriority') {
    const copied = copiedValue(args[1], true);
    if ('skipped' in copied) return { sessionData: copied.skipped };
    return { sessionData: opDelta({ kind: 'set', instance, path, value: copied.value }) };
  }
  if (name === 'update') {
    const sessionData = updateDelta(args[1], instance, path);
    if (sessionData === undefined) return {};
    return { sessionData };
  }
  if (name === 'push') {
    const copied = copiedValue(args[1], true);
    if ('skipped' in copied) return { sessionData: copied.skipped };
    return { pendingPushValue: { value: copied.value } };
  }
  return {};
}

/** A snapshot's path: its `ref`'s, else its key under the call's path, else the call's path. */
function snapshotPathOf(snap: Fields, fallbackPath?: string): string | undefined {
  const fromRef = pathOf(snap.ref);
  if (isValidRtdbSessionPath(fromRef)) return fromRef;
  if (typeof snap.key === 'string' && snap.key.length > 0 && isValidRtdbSessionPath(fallbackPath)) {
    const prefix = fallbackPath === '/' ? '' : fallbackPath;
    const candidate = `${prefix}/${snap.key}`;
    if (isValidRtdbSessionPath(candidate)) return candidate;
  }
  if (isValidRtdbSessionPath(fallbackPath)) return fallbackPath;
  return undefined;
}

/** The path of the child a value names under the call's path (`rooms/{id}` and the child's key), or undefined. */
function keyedChildPath(site: ObservedSite, child: Fields): string | undefined {
  if (typeof child.key !== 'string' || child.key.length === 0) return undefined;
  if (!isValidRtdbSessionPath(site.path)) return undefined;
  if (site.path === '/') return `/${child.key}`;
  return `${site.path}/${child.key}`;
}

/** Whether a read ran on a filtered query, whose value holds only the children it matched. */
function isFilteredRead(site: ObservedSite, snap: Fields): boolean {
  return site.rtdbFilteredQuery === true || queryIdOf(snap._query) !== 'default';
}

/** The delta of a `get` or `onValue` snapshot: `set` of its value, or `update` of a filtered query's children. */
function valueSnapshotDelta(site: ObservedSite, snap: Fields, read: () => unknown): ObservedSessionDelta | undefined {
  const instance = site.instance ?? UNREAD_INSTANCE;
  const path = snapshotPathOf(snap, site.path);
  if (path === undefined) return skipDeltaOf('unsupported');
  const copied = copiedValue(read(), false);
  if ('skipped' in copied) return copied.skipped;
  if (!isFilteredRead(site, snap)) return opDelta({ kind: 'set', instance, path, value: copied.value });
  if (copied.value === null) return undefined;
  if (!isPlainObject(copied.value)) return skipDeltaOf('unsupported');
  if (Object.keys(copied.value).length === 0) return undefined;
  return opDelta({ kind: 'update', instance, path, value: copied.value });
}

/** Whether a value is a snapshot this file reads: an object with its own `val()`. */
function isSnapshot(value: unknown): value is Fields & { val: (...args: unknown[]) => unknown } {
  return isObject(value) && typeof value.val === 'function';
}

/** Extracts bounded session-observed RTDB values from resolved `get` and `push` calls. */
export function databaseResult(site: ObservedSite, value: unknown): ResultReading {
  if (site.name === 'push' && site.pendingPushValue !== undefined && isObject(value)) {
    const resolvedPath = pathOf(value) ?? keyedChildPath(site, value);
    if (!isValidRtdbSessionPath(resolvedPath)) return { sessionData: skipDeltaOf('unsupported') };
    const instance = site.instance ?? UNREAD_INSTANCE;
    return { sessionData: opDelta({ kind: 'set', instance, path: resolvedPath, value: site.pendingPushValue.value }) };
  }
  if (site.name === 'get' && isSnapshot(value)) {
    const sessionData = valueSnapshotDelta(site, value, () => Reflect.apply(value.val, value, []));
    if (sessionData === undefined) return {};
    return { sessionData };
  }
  return {};
}

/**
 * Extracts bounded session-observed RTDB values from `onValue`, `onChildAdded`,
 * `onChildChanged`, and `onChildRemoved` listener deliveries.
 */
export function databaseDelivery(site: ObservedSite, value: unknown): ObservedSessionDelta | undefined {
  if (!isSnapshot(value)) return undefined;
  const instance = site.instance ?? UNREAD_INSTANCE;
  const isChildListener = site.name === 'onChildAdded' || site.name === 'onChildChanged' || site.name === 'onChildRemoved';
  if (isChildListener) {
    const childPath = snapshotPathOf(value, undefined) ?? keyedChildPath(site, value);
    if (!isValidRtdbSessionPath(childPath)) return skipDeltaOf('unsupported');
    if (site.name === 'onChildRemoved') return opDelta({ kind: 'remove', instance, path: childPath });
    const copied = copiedValue(Reflect.apply(value.val, value, []), false);
    if ('skipped' in copied) return copied.skipped;
    return opDelta({ kind: 'set', instance, path: childPath, value: copied.value });
  }
  if (site.name === 'onValue') return valueSnapshotDelta(site, value, () => Reflect.apply(value.val, value, []));
  return undefined;
}
