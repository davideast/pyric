/**
 * Point-in-time and initial Firestore document store reconstruction for `pyric verify`.
 */
import { Timestamp } from 'pyric/rules/internal';
import {
  applyUnescapedUserMapPaths,
  decodeSnapshotMapForEnv,
} from 'pyric/sandbox/internal';

import type { PyricVerifyFixture } from './fixture.js';

export function readOwnDocument(
  docs: Record<string, Record<string, unknown>>,
  docPath: string,
): Record<string, unknown> | null {
  if (!Object.hasOwn(docs, docPath)) return null;
  return docs[docPath] ?? null;
}

export function decodeCapturedFirestoreDoc(
  docData: Record<string, unknown>,
  unescapedPaths?: readonly (readonly (string | number)[])[],
): Record<string, unknown> {
  const stamped = applyUnescapedUserMapPaths(docData, unescapedPaths);
  return decodeSnapshotMapForEnv(stamped);
}

export function decodeCapturedFirestoreDocStore(
  docs: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [docPath, docData] of Object.entries(docs)) {
    Object.defineProperty(out, docPath, {
      value: decodeSnapshotMapForEnv(docData),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

export function reconstructInitialFirestoreDocuments(
  fixture: PyricVerifyFixture,
  predecodedFinalDocs?: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const firestore = fixture.services.firestore;
  if (!firestore) return {};
  const finalDocs = predecodedFinalDocs ?? decodeCapturedFirestoreDocStore(firestore.state.documents);
  const firstSeenState = new Map<string, Record<string, unknown> | null>();
  for (const event of fixture.events) {
    if (event.kind === 'request') {
      const service = (event as { service?: unknown }).service;
      if (service !== undefined && service !== 'firestore') continue;
      if (!firstSeenState.has(event.path) && event.resourceBefore !== undefined) {
        let beforeDoc: Record<string, unknown> | null = null;
        if (event.resourceBefore.exists && event.resourceBefore.data !== null) {
          beforeDoc = decodeCapturedFirestoreDoc(
            event.resourceBefore.data,
            event.resourceBefore.unescapedPaths,
          );
        }
        firstSeenState.set(event.path, beforeDoc);
      }
    } else if (event.kind === 'write') {
      if (!firstSeenState.has(event.path)) {
        let priorDoc: Record<string, unknown> | null = null;
        if (event.priorState !== null) {
          priorDoc = decodeCapturedFirestoreDoc(event.priorState, event.priorUnescapedPaths);
        }
        firstSeenState.set(event.path, priorDoc);
      }
    }
  }
  const initialData: Record<string, Record<string, unknown>> = {};
  for (const [docPath, docData] of firstSeenState.entries()) {
    if (docData !== null) {
      Object.defineProperty(initialData, docPath, {
        value: docData,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  for (const [docPath, docData] of Object.entries(finalDocs)) {
    if (!firstSeenState.has(docPath)) {
      Object.defineProperty(initialData, docPath, {
        value: docData,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return initialData;
}

export function buildPointInTimeFirestoreDocs(
  fixture: PyricVerifyFixture,
  initialData: Record<string, Record<string, unknown>>,
): Map<string, Record<string, Record<string, unknown>>> {
  const currentDocs: Record<string, Record<string, unknown>> = { ...initialData };
  const preGroupDocs = new Map<string, Record<string, Record<string, unknown>>>();
  const docsByEventId = new Map<string, Record<string, Record<string, unknown>>>();
  for (const event of fixture.events) {
    const groupId = (event as { groupId?: unknown }).groupId;
    if (typeof groupId === 'string' && !preGroupDocs.has(groupId)) {
      preGroupDocs.set(groupId, { ...currentDocs });
    }
    if (event.kind === 'request') {
      const snapshot = typeof groupId === 'string' ? preGroupDocs.get(groupId)! : currentDocs;
      docsByEventId.set(event.id, { ...snapshot });
    } else if (event.kind === 'write') {
      if (event.nextState === null || event.method === 'delete') {
        delete currentDocs[event.path];
      } else {
        Object.defineProperty(currentDocs, event.path, {
          value: decodeCapturedFirestoreDoc(event.nextState, event.nextUnescapedPaths),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
  }
  return docsByEventId;
}

function isPlainProjectedObject(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function resolveProjectedServerTimestamps(value: unknown, serverTime: Timestamp): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => resolveProjectedServerTimestamps(item, serverTime));
  }
  if (value === null || typeof value !== 'object') return value;
  const unescapedTag = Symbol.for('pyric.unescapedMap');
  const isUnescaped = (value as Record<symbol, unknown>)[unescapedTag] === true;
  const rec = value as Record<string, unknown>;
  if (
    !isUnescaped &&
    (rec.__type === 'serverTimestamp' ||
      rec._methodName === 'serverTimestamp' ||
      rec._methodName === 'FieldValue.serverTimestamp')
  ) {
    return serverTime;
  }
  if (!isPlainProjectedObject(value)) return value;
  if (
    !isUnescaped &&
    Object.keys(rec).length === 2 &&
    Object.hasOwn(rec, 'type') &&
    rec.type === 'pyric/map/1.0' &&
    isPlainProjectedObject(rec.fields)
  ) {
    const fieldsOut: Record<string, unknown> = {};
    for (const [fk, fv] of Object.entries(rec.fields as Record<string, unknown>)) {
      Object.defineProperty(fieldsOut, fk, {
        value: resolveProjectedServerTimestamps(fv, serverTime),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return { type: 'pyric/map/1.0', fields: fieldsOut };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    Object.defineProperty(out, k, {
      value: resolveProjectedServerTimestamps(v, serverTime),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  if (isUnescaped) {
    Object.defineProperty(out, unescapedTag, { value: true });
  }
  return out;
}
