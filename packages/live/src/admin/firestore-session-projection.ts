/**
 * Projected (`Query.select(...)`), field-masked (`Firestore.getAll(..., { fieldMask })`),
 * and converted-query snapshot reconciliation for `@google-cloud/firestore`.
 *
 * Emits per-document `projection`, `delete`, or `invalidate` ops alongside
 * `skipped: { unsupported: 1 }` so returned documents whose fields changed on
 * the server are purged from `ObservedSessionDataStore` without wiping
 * unrelated cached documents or overwriting whole documents with partial masks.
 */
import { isObject } from '../database.js';
import { DeltaOps, querySnapshotChanges } from '../firestore-session-capture.js';
import { skipDeltaOf, type ObservedSessionDelta } from '../session-data.js';
import {
  adminSnapshotExists,
  docPathOfAdminRef,
  docSnapPathOf,
  hasAdminCustomConverter,
  rawProjectionOf,
  type AdminGetAllCall,
} from './firestore-session-staging.js';
import { adminDocFields, adminFieldPathString } from './firestore-session-values.js';

function isUnsupportedProjectedDoc(docSnap: unknown, sourceRef?: unknown): boolean {
  return !isObject(docSnap) || hasAdminCustomConverter(sourceRef) || hasAdminCustomConverter(docSnap);
}

function projectionFieldsOf(target: unknown): readonly string[] | undefined {
  const projection = rawProjectionOf(target);
  if (!isObject(projection)) return undefined;
  const rawFields: unknown = Reflect.get(projection, 'fields');
  if (!Array.isArray(rawFields)) return undefined;
  const fields: string[] = [];
  for (const entry of rawFields) {
    if (!isObject(entry)) return undefined;
    const rawPath: unknown = Reflect.get(entry, 'fieldPath');
    if (typeof rawPath !== 'string') return undefined;
    if (rawPath === '__name__') continue;
    if (rawPath.includes('`')) return undefined;
    const normalized = adminFieldPathString(rawPath);
    if (normalized === undefined) return undefined;
    fields.push(normalized);
  }
  return fields;
}

export function fieldMaskStringsOf(rawMask: unknown): readonly string[] | undefined {
  if (!Array.isArray(rawMask)) return undefined;
  const fields: string[] = [];
  for (const entry of rawMask) {
    if (isObject(entry) && Reflect.get(entry, 'formattedName') === '__name__') continue;
    const normalized = adminFieldPathString(entry);
    if (normalized === undefined) return undefined;
    fields.push(normalized);
  }
  return fields;
}

function reconcileAdminProjectedDoc(
  collector: DeltaOps,
  docSnap: unknown,
  maskFields: readonly string[] | undefined,
  fallbackPath?: string,
  sourceRef?: unknown,
): void {
  if (!isObject(docSnap)) {
    collector.invalidate(undefined);
    return;
  }
  const path = docSnapPathOf(docSnap, fallbackPath);
  if (path === undefined) {
    collector.invalidate(undefined);
    return;
  }
  if (!adminSnapshotExists(docSnap)) {
    if (!collector.refusesMore()) {
      collector.add(() => ({ ok: true, value: { kind: 'delete', path } }));
    }
    return;
  }
  if (maskFields === undefined || isUnsupportedProjectedDoc(docSnap, sourceRef)) {
    collector.invalidate(path);
    return;
  }
  const dataFn: unknown = Reflect.get(docSnap, 'data');
  if (typeof dataFn !== 'function') {
    collector.invalidate(path);
    return;
  }
  collector.addProjection(path, maskFields, (budget) =>
    adminDocFields(Reflect.apply(dataFn, docSnap, []), budget),
  );
}

/** Reconciles returned snapshots from a `Firestore.getAll(..., { fieldMask })` read against cached docs. */
export function reconcileAdminMaskedGetAll(
  subject: AdminGetAllCall,
  snapshots: unknown,
): ObservedSessionDelta {
  const collector = new DeltaOps();
  collector.skip('unsupported');
  if (!Array.isArray(snapshots)) {
    collector.invalidate(undefined);
    return collector.delta() ?? skipDeltaOf('unsupported');
  }
  for (let i = 0; i < snapshots.length; i++) {
    const ref = subject.docRefs[i];
    reconcileAdminProjectedDoc(collector, snapshots[i], subject.fieldMask, docPathOfAdminRef(ref), ref);
  }
  return collector.delta() ?? skipDeltaOf('unsupported');
}

/** Reconciles returned snapshots from a projected or converted Admin query read/delivery without overwriting whole docs. */
export function reconcileAdminProjectedQuerySnapshot(
  query: unknown,
  snap: unknown,
  useChanges: boolean,
): ObservedSessionDelta {
  const collector = new DeltaOps();
  collector.skip('unsupported');
  if (!isObject(snap)) {
    collector.invalidate(undefined);
    return collector.delta() ?? skipDeltaOf('unsupported');
  }
  const isConverted = hasAdminCustomConverter(query) || hasAdminCustomConverter(snap);
  let maskFields: readonly string[] | undefined;
  if (!isConverted) {
    maskFields = projectionFieldsOf(query);
    if (maskFields === undefined) maskFields = projectionFieldsOf(snap);
  }
  let changes: ReturnType<typeof querySnapshotChanges>;
  if (useChanges) changes = querySnapshotChanges(snap);
  if (changes !== undefined) {
    for (const item of changes) {
      if (item.kind === 'removed' || isConverted) {
        let path: string | undefined;
        if (isObject(item.doc)) path = docSnapPathOf(item.doc);
        collector.invalidate(path);
        continue;
      }
      reconcileAdminProjectedDoc(collector, item.doc, maskFields);
    }
    return collector.delta() ?? skipDeltaOf('unsupported');
  }
  const documents: unknown = Reflect.get(snap, 'docs');
  if (!Array.isArray(documents)) {
    collector.invalidate(undefined);
    return collector.delta() ?? skipDeltaOf('unsupported');
  }
  for (const docSnap of documents) {
    if (isConverted) {
      let path: string | undefined;
      if (isObject(docSnap)) path = docSnapPathOf(docSnap);
      collector.invalidate(path);
    } else {
      reconcileAdminProjectedDoc(collector, docSnap, maskFields);
    }
  }
  return collector.delta() ?? skipDeltaOf('unsupported');
}
