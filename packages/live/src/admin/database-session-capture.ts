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
import {
  attachRtdbPriority,
  copyRtdbSessionValue,
  INVALID_RTDB_SESSION,
  isForbiddenRtdbKey,
  isValidRtdbPriorityValue,
  isValidRtdbSessionPath,
  opDelta,
  OVERSIZED_RTDB_SESSION,
  readSnapshotValueWithPriority,
  rtdbInFlightWrites,
  stripFilteredQueryRootPriority,
} from '../database-session-capture.js';
import { isPlainObject } from '../json-copy.js';
import type { CallContext, ObservedSite, ResultReading } from '../observe.js';
import {
  chargeContainer,
  chargeScalar,
  chargeString,
  MAX_SESSION_ITEM_BYTES,
  type SessionBudget,
} from '../session-budget.js';
import { skipDeltaOf, type ObservedSessionDelta } from '../session-data.js';

const MAX_SENTINEL_SCAN_DEPTH = 20;
const ADMIN_RTDB_WRITES: ReadonlySet<string> = new Set([
  'Reference.remove',
  'Reference.set',
  'Reference.setWithPriority',
  'Reference.setPriority',
  'Reference.update',
  'Reference.push',
]);

type Fields = Record<string, unknown>;

interface AdminOnceSubject {
  readonly kind: 'admin-rtdb-once';
  readonly eventType: string;
}

function containsRtdbServerSentinel(value: unknown, depth = 0): boolean {
  if (depth > MAX_SENTINEL_SCAN_DEPTH) return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsRtdbServerSentinel(item, depth + 1));
  }
  if (!isPlainObject(value)) return false;
  if (Object.prototype.hasOwnProperty.call(value, '.sv')) return true;
  return Object.values(value).some((entry) => containsRtdbServerSentinel(entry, depth + 1));
}

function copiedAdminRtdbValue(
  value: unknown,
  rejectServerSentinels: boolean,
): { value: unknown } | { skipped: ObservedSessionDelta } {
  if (rejectServerSentinels && containsRtdbServerSentinel(value)) {
    return { skipped: skipDeltaOf('unsupported') };
  }
  const copied = copyRtdbSessionValue(value, 0, { left: MAX_SESSION_ITEM_BYTES }, false);
  if (copied === OVERSIZED_RTDB_SESSION) return { skipped: skipDeltaOf('oversized') };
  if (copied === INVALID_RTDB_SESSION) return { skipped: skipDeltaOf('unsupported') };
  return { value: copied };
}

function adminUpdateDelta(rawPatch: unknown, instance: string, path: string): ObservedSessionDelta | undefined {
  if (!isPlainObject(rawPatch) || containsRtdbServerSentinel(rawPatch)) {
    return skipDeltaOf('unsupported');
  }
  const budget: SessionBudget = { left: MAX_SESSION_ITEM_BYTES };
  const patch: Fields = {};
  let hasEntry = false;
  if (!chargeContainer(budget)) return skipDeltaOf('oversized');
  for (const [relKey, rawVal] of Object.entries(rawPatch)) {
    if (rawVal === undefined) continue;
    const relSegments = relKey.split('/').filter((seg) => seg.length > 0);
    if (relSegments.length === 0 || relSegments.some(isForbiddenRtdbKey)) return skipDeltaOf('unsupported');
    if (!chargeString(budget, relKey)) return skipDeltaOf('oversized');
    const copied = copyRtdbSessionValue(rawVal, 0, budget, false);
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
  if (isValidRtdbSessionPath(fromDelegate)) return fromDelegate;
  const direct = pathOf(target);
  if (isValidRtdbSessionPath(direct)) return direct;
  return undefined;
}

function childPathUnder(parentPath: string | undefined, childKey: unknown): string | undefined {
  if (typeof childKey !== 'string' || childKey.length === 0) return undefined;
  if (!isValidRtdbSessionPath(parentPath)) return undefined;
  let candidate = `${parentPath}/${childKey}`;
  if (parentPath === '/') candidate = `/${childKey}`;
  if (!isValidRtdbSessionPath(candidate)) return undefined;
  return candidate;
}

function pushChildPath(parentPath: string | undefined, childRef: unknown): string | undefined {
  const fromRef = compatPathOf(childRef);
  if (fromRef !== undefined) return fromRef;
  if (isObject(childRef)) return childPathUnder(parentPath, childRef.key);
  return undefined;
}

function withAdminWriteStarter(
  onCallStart: CallContext['onCallStart'],
  base: Pick<CallContext, 'subject' | 'sessionData'>,
): Pick<CallContext, 'subject' | 'sessionData' | 'onCallStart'> {
  if (onCallStart === undefined) return base;
  return { ...base, onCallStart };
}

/** Session context extracted before an Admin RTDB method executes. */
export function adminDatabaseSessionContext(
  name: string,
  args: readonly unknown[],
  instance: string,
  path: string | undefined,
): Pick<CallContext, 'subject' | 'sessionData' | 'onCallStart'> {
  if (name === 'Query.once') {
    let eventType = 'value';
    if (typeof args[0] === 'string') eventType = args[0];
    const subject: AdminOnceSubject = { kind: 'admin-rtdb-once', eventType };
    return { subject };
  }
  const onCallStart = rtdbInFlightWrites().writeLeaseStarter({
    name,
    instance,
    path,
    patchArg: args[0],
    adminPushChildPath: pushChildPath(path, args[0]),
  });
  if (!isValidRtdbSessionPath(path)) {
    if (ADMIN_RTDB_WRITES.has(name)) {
      return withAdminWriteStarter(onCallStart, { sessionData: skipDeltaOf('unsupported') });
    }
    return withAdminWriteStarter(onCallStart, {});
  }
  if (name === 'Reference.remove') {
    return withAdminWriteStarter(onCallStart, { sessionData: opDelta({ kind: 'remove', instance, path }) });
  }
  if (name === 'Reference.setPriority') {
    return withAdminWriteStarter(onCallStart, { sessionData: opDelta({ kind: 'invalidate', instance, path }) });
  }
  if (name === 'Reference.set' || name === 'Reference.setWithPriority') {
    let validPriority: string | number | null = null;
    if (name === 'Reference.setWithPriority') {
      const rawPriority = args[1];
      if (!isValidRtdbPriorityValue(rawPriority) || containsRtdbServerSentinel(rawPriority)) {
        return withAdminWriteStarter(onCallStart, { sessionData: skipDeltaOf('unsupported') });
      }
      validPriority = rawPriority;
    }
    const copied = copiedAdminRtdbValue(args[0], true);
    if ('skipped' in copied) return withAdminWriteStarter(onCallStart, { sessionData: copied.skipped });
    let nextValue = copied.value;
    if (validPriority !== null) {
      const priorityBudget: SessionBudget = { left: MAX_SESSION_ITEM_BYTES };
      const chargedPriority =
        typeof validPriority === 'string'
          ? chargeString(priorityBudget, validPriority)
          : chargeScalar(priorityBudget, validPriority);
      if (!chargedPriority) {
        return withAdminWriteStarter(onCallStart, { sessionData: skipDeltaOf('oversized') });
      }
      nextValue = attachRtdbPriority(nextValue, validPriority);
    }
    return withAdminWriteStarter(onCallStart, {
      sessionData: opDelta({ kind: 'set', instance, path, value: nextValue }),
    });
  }
  if (name === 'Reference.update') {
    const sessionData = adminUpdateDelta(args[0], instance, path);
    if (sessionData === undefined) return withAdminWriteStarter(onCallStart, {});
    return withAdminWriteStarter(onCallStart, { sessionData });
  }
  if (name === 'Reference.push') {
    const childPath = pushChildPath(path, args[0]);
    if (childPath === undefined) {
      return withAdminWriteStarter(onCallStart, { sessionData: skipDeltaOf('unsupported') });
    }
    const copied = copiedAdminRtdbValue(args[1], true);
    if ('skipped' in copied) return withAdminWriteStarter(onCallStart, { sessionData: copied.skipped });
    return withAdminWriteStarter(onCallStart, {
      sessionData: opDelta({ kind: 'set', instance, path: childPath, value: copied.value }),
    });
  }
  return withAdminWriteStarter(onCallStart, {});
}

function isSnapshot(value: unknown): value is Fields & { val: (...args: unknown[]) => unknown } {
  return isObject(value) && typeof value.val === 'function';
}

function snapshotPathOf(snap: Fields, fallbackPath?: string): string | undefined {
  const fromRef = compatPathOf(snap.ref);
  if (fromRef !== undefined) return fromRef;
  if (isObject(snap._delegate)) {
    const fromSnapDelegate = pathOf(snap._delegate.ref);
    if (isValidRtdbSessionPath(fromSnapDelegate)) return fromSnapDelegate;
  }
  if (isValidRtdbSessionPath(fallbackPath)) return fallbackPath;
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
  const copied = copiedAdminRtdbValue(readSnapshotValueWithPriority(snap), false);
  if ('skipped' in copied) return copied.skipped;
  if (forceUnfiltered || !isFilteredSnap(site, snap)) {
    return opDelta({ kind: 'set', instance, path, value: copied.value });
  }
  if (copied.value === null) {
    return opDelta({ kind: 'invalidate', instance, path });
  }
  if (!isPlainObject(copied.value)) return skipDeltaOf('unsupported');
  const patch = stripFilteredQueryRootPriority(copied.value);
  if (patch === undefined) return skipDeltaOf('unsupported');
  if (Object.keys(patch).length === 0) {
    return opDelta({ kind: 'invalidate', instance, path });
  }
  return {
    rtdb: [
      { kind: 'invalidate', instance, path },
      { kind: 'update', instance, path, value: patch },
    ],
  };
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
    if (isFilteredSnap(site, snap)) return opDelta({ kind: 'invalidate', instance, path: childPath });
    return opDelta({ kind: 'remove', instance, path: childPath });
  }
  const copied = copiedAdminRtdbValue(readSnapshotValueWithPriority(snap), false);
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

function isOnceSubject(subject: unknown): subject is AdminOnceSubject {
  return isObject(subject) && subject.kind === 'admin-rtdb-once' && typeof subject.eventType === 'string';
}

function onceEventTypeOf(subject: unknown): string {
  if (isOnceSubject(subject)) return subject.eventType;
  return 'value';
}

function isCommittedTransactionResult(
  site: ObservedSite,
  value: unknown,
): value is Fields & { committed: true; snapshot: unknown } {
  return site.name === 'Reference.transaction' && isObject(value) && value.committed === true;
}

/** Extracts bounded session-observed RTDB values from resolved `Query.get`, `Query.once`, and `Reference.transaction` calls. */
export function adminDatabaseResult(site: ObservedSite, value: unknown): ResultReading {
  if (site.name === 'Query.get' && isSnapshot(value)) {
    const instance = site.instance ?? UNREAD_INSTANCE;
    const readPath = snapshotPathOf(value, site.path);
    if (readPath === undefined) return { sessionData: skipDeltaOf('unsupported') };
    const sessionData = rtdbInFlightWrites().applyDeliveryGuard(instance, readPath, () =>
      valueSnapshotDelta(site, value),
    );
    if (sessionData === undefined) return {};
    return { sessionData };
  }
  if (site.name === 'Query.once' && isSnapshot(value)) {
    const instance = site.instance ?? UNREAD_INSTANCE;
    const eventType = onceEventTypeOf(site.subject);
    let sessionData: ObservedSessionDelta | undefined;
    if (isChildEventType(eventType)) {
      let childPath = snapshotPathOf(value, undefined);
      if (childPath === undefined) childPath = childPathUnder(site.path, value.key);
      if (childPath === undefined) return { sessionData: skipDeltaOf('unsupported') };
      sessionData = rtdbInFlightWrites().applyDeliveryGuard(instance, childPath, () =>
        childEventDelta(site, eventType, value),
      );
    } else {
      const readPath = snapshotPathOf(value, site.path);
      if (readPath === undefined) return { sessionData: skipDeltaOf('unsupported') };
      sessionData = rtdbInFlightWrites().applyDeliveryGuard(instance, readPath, () =>
        valueSnapshotDelta(site, value),
      );
    }
    if (sessionData === undefined) return {};
    return { sessionData };
  }
  if (isCommittedTransactionResult(site, value)) {
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
  const instance = site.instance ?? UNREAD_INSTANCE;
  if (isChildEventType(eventType)) {
    const childPath = snapshotPathOf(value, undefined) ?? childPathUnder(site.path, value.key);
    if (childPath === undefined) return skipDeltaOf('unsupported');
    return rtdbInFlightWrites().applyDeliveryGuard(instance, childPath, () => childEventDelta(site, eventType, value));
  }
  if (eventType === 'value') {
    const deliveryPath = snapshotPathOf(value, site.path);
    if (deliveryPath === undefined) return skipDeltaOf('unsupported');
    return rtdbInFlightWrites().applyDeliveryGuard(instance, deliveryPath, () => valueSnapshotDelta(site, value));
  }
  return undefined;
}
