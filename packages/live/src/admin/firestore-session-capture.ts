/**
 * Session-scoped data capture hooks for the Admin Firestore row
 * (`@google-cloud/firestore`), turning successful Admin reads, listeners,
 * writes, `getAll`, `WriteBatch.commit`, and committed `Firestore.runTransaction`
 * calls into bounded `ObservedSessionDelta` sidecars while keeping
 * `LiveCallRecord` completely free of document values.
 */
import { isValidDocPath, normalizeDocPath, type SessionCopyResult } from '../firestore-session-values.js';
import type { CallContext, ObservedSite, ResultReading } from '../observe.js';
import {
  skipDeltaOf,
  type ObservedFirestoreSessionOp,
  type ObservedSessionDelta,
} from '../session-data.js';
import {
  AdminDeltaCollector,
  addAdminDocSnapshot,
  addAdminQuerySnapshot,
  adminSnapshotExists,
  beginAdminTransactionSession,
  commitAdminBatchDelta,
  commitAdminTransactionDelta,
  docPathOfAdminRef,
  docSnapPathOf,
  hasAdminCustomConverter,
  isAdminDocumentSnapshot,
  parseAdminGetAllCall,
  type AdminGetAllCall,
} from './firestore-session-staging.js';
import {
  adminAddDocFields,
  adminCreateDocOp,
  adminDocFields,
  adminSetDocOp,
  adminUpdateDocOp,
} from './firestore-session-values.js';

function isObject(value: unknown): value is object {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

function opDelta(op: ObservedFirestoreSessionOp): ObservedSessionDelta {
  return { firestore: [op] };
}

function copiedOpDelta(op: SessionCopyResult<ObservedFirestoreSessionOp>): ObservedSessionDelta {
  if (op.ok) return opDelta(op.value);
  return skipDeltaOf(op.reason);
}

function isGetAllCall(subject: unknown): subject is AdminGetAllCall {
  return isObject(subject) && Reflect.get(subject, 'kind') === 'admin-get-all';
}

function isConvertedWriteMethod(name: string): boolean {
  return (
    name === 'DocumentReference.create' ||
    name === 'DocumentReference.set' ||
    name === 'DocumentReference.update' ||
    name === 'DocumentReference.delete' ||
    name === 'CollectionReference.add'
  );
}

/** Session context extracted before an Admin Firestore method executes. */
export function adminFirestoreSessionContext(
  name: string,
  args: readonly unknown[],
  self: unknown,
  path: string | undefined,
): Pick<CallContext, 'subject' | 'sessionData' | 'pendingAddDocFields'> {
  if (name === 'WriteBatch.commit') {
    const sessionData = commitAdminBatchDelta(self);
    if (sessionData !== undefined) return { subject: self, sessionData };
    return { subject: self };
  }
  if (name === 'Firestore.getAll') {
    return { subject: parseAdminGetAllCall(args) };
  }
  if (name === 'Firestore.runTransaction') {
    return { subject: beginAdminTransactionSession(args[0]) };
  }

  if (hasAdminCustomConverter(self)) {
    if (isConvertedWriteMethod(name)) return { subject: self, sessionData: skipDeltaOf('unsupported') };
    return { subject: self };
  }

  if (name === 'DocumentReference.delete') {
    if (!isValidDocPath(path)) return { subject: self, sessionData: skipDeltaOf('unsupported') };
    return { subject: self, sessionData: opDelta({ kind: 'delete', path: normalizeDocPath(path) }) };
  }
  if (name === 'DocumentReference.create') {
    if (path === undefined) return { subject: self, sessionData: skipDeltaOf('unsupported') };
    return { subject: self, sessionData: copiedOpDelta(adminCreateDocOp(path, args[0])) };
  }
  if (name === 'DocumentReference.set') {
    if (path === undefined) return { subject: self, sessionData: skipDeltaOf('unsupported') };
    return { subject: self, sessionData: copiedOpDelta(adminSetDocOp(path, args[0], args[1])) };
  }
  if (name === 'DocumentReference.update') {
    if (path === undefined) return { subject: self, sessionData: skipDeltaOf('unsupported') };
    return { subject: self, sessionData: copiedOpDelta(adminUpdateDocOp(path, args)) };
  }
  if (name === 'CollectionReference.add') {
    const fields = adminAddDocFields(args[0]);
    if (fields.ok) return { subject: self, pendingAddDocFields: fields.value };
    return { subject: self, sessionData: skipDeltaOf(fields.reason) };
  }

  return { subject: self };
}

function querySnapshotDelta(snap: object, useChanges: boolean): ObservedSessionDelta | undefined {
  if (hasAdminCustomConverter(snap)) return skipDeltaOf('unsupported');
  const collector = new AdminDeltaCollector();
  addAdminQuerySnapshot(collector, snap, useChanges);
  return collector.delta();
}

function documentSnapshotDelta(snap: object, fallbackPath?: string): ObservedSessionDelta {
  if (hasAdminCustomConverter(snap)) return skipDeltaOf('unsupported');
  const docPath = docSnapPathOf(snap, fallbackPath);
  if (docPath === undefined) return skipDeltaOf('unsupported');
  if (!adminSnapshotExists(snap)) return opDelta({ kind: 'delete', path: docPath });
  const dataFn: unknown = Reflect.get(snap, 'data');
  if (typeof dataFn !== 'function') return skipDeltaOf('unsupported');
  const fields = adminDocFields(Reflect.apply(dataFn, snap, []));
  if (!fields.ok) return skipDeltaOf(fields.reason);
  return opDelta({ kind: 'set', path: docPath, data: fields.value });
}

function addedAdminDocDelta(site: ObservedSite, value: object): ObservedSessionDelta | undefined {
  const pending = site.pendingAddDocFields;
  if (pending === undefined) return undefined;
  const resolvedPath = docPathOfAdminRef(value);
  if (resolvedPath === undefined) return skipDeltaOf('unsupported');
  const op: { kind: 'set'; path: string; data: Record<string, unknown>; deleteFields?: readonly string[] } = {
    kind: 'set',
    path: resolvedPath,
    data: pending.data,
  };
  if (pending.deleteFields !== undefined) op.deleteFields = pending.deleteFields;
  return opDelta(op);
}

function getAllResultDelta(subject: AdminGetAllCall, value: unknown): ObservedSessionDelta | undefined {
  if (subject.hasFieldMask) return skipDeltaOf('unsupported');
  if (!Array.isArray(value)) return undefined;
  const collector = new AdminDeltaCollector();
  for (let i = 0; i < value.length; i++) {
    if (collector.refusesMore()) {
      collector.truncateRemaining(value.length - i - 1);
      break;
    }
    const ref = subject.docRefs[i];
    if (!addAdminDocSnapshot(collector, value[i], docPathOfAdminRef(ref), ref)) {
      collector.truncateRemaining(value.length - i - 1);
      break;
    }
  }
  return collector.delta();
}

/** Result reading for resolved Admin Firestore calls. */
export function adminFirestoreResult(site: ObservedSite, value: unknown): ResultReading {
  if (site.name === 'Query.get') {
    const reading: { billedDocuments?: number; sessionData?: ObservedSessionDelta } = {};
    if (isObject(value)) {
      const size: unknown = Reflect.get(value, 'size');
      if (typeof size === 'number') reading.billedDocuments = Math.max(size, 1);
    }
    if (hasAdminCustomConverter(site.subject)) {
      reading.sessionData = skipDeltaOf('unsupported');
      return reading;
    }
    if (isObject(value)) {
      const sessionData = querySnapshotDelta(value, false);
      if (sessionData !== undefined) reading.sessionData = sessionData;
    }
    return reading;
  }

  if (site.name === 'DocumentReference.get') {
    if (hasAdminCustomConverter(site.subject) || !isObject(value)) {
      return { sessionData: skipDeltaOf('unsupported') };
    }
    return { sessionData: documentSnapshotDelta(value, site.path) };
  }

  if (site.name === 'CollectionReference.add') {
    if (!isObject(value)) return {};
    const sessionData = addedAdminDocDelta(site, value);
    if (sessionData === undefined) return {};
    return { sessionData };
  }

  if (site.name === 'Firestore.getAll' && isGetAllCall(site.subject)) {
    const sessionData = getAllResultDelta(site.subject, value);
    if (sessionData === undefined) return {};
    return { sessionData };
  }

  if (site.name === 'Firestore.runTransaction') {
    const sessionData = commitAdminTransactionDelta(site.subject);
    if (sessionData === undefined) return {};
    return { sessionData };
  }

  return {};
}

/** Listener delivery extractor for Admin `DocumentReference.onSnapshot` and `Query.onSnapshot`. */
export function adminFirestoreDelivery(site: ObservedSite, value: unknown): ObservedSessionDelta | undefined {
  if (hasAdminCustomConverter(site.subject) || !isObject(value) || hasAdminCustomConverter(value)) {
    return skipDeltaOf('unsupported');
  }
  if (site.name === 'DocumentReference.onSnapshot' || isAdminDocumentSnapshot(value)) {
    return documentSnapshotDelta(value, site.path);
  }
  return querySnapshotDelta(value, true);
}
