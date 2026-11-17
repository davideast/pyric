/**
 * Builds live SDK `Query` objects from `QuerySpec` ASTs and serializes
 * `DocumentSnapshot` / `QuerySnapshot` reads into canonical trace payloads.
 */

import type { FirestoreSurface } from './interpreter.js';
import type { CursorSpec, FilterSpec, QuerySpec } from './sequence.js';
import {
  canonicalizeReadValue,
  materializeQueryField,
  materializeValue,
  type ValueBuilders,
} from './value-serialize.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFn = (...args: any[]) => any;
/* eslint-enable @typescript-eslint/no-explicit-any */

function buildFilterConstraint(
  fs: FirestoreSurface,
  builders: ValueBuilders,
  spec: FilterSpec,
): unknown {
  if (spec.kind === 'where') {
    return fs.where(
      materializeQueryField(builders, spec.field),
      spec.op,
      materializeValue(builders, spec.value),
    );
  }
  const children = spec.filters.map((child) => buildFilterConstraint(fs, builders, child));
  if (spec.kind === 'and') {
    return fs.and(...children);
  }
  return fs.or(...children);
}

async function resolveCursorArgs(
  fs: FirestoreSurface,
  builders: ValueBuilders,
  dbHandle: unknown,
  cursor: CursorSpec,
): Promise<unknown[] | null> {
  if (cursor.mode === 'values') {
    return cursor.values.map((item) => materializeValue(builders, item));
  }
  const snap = await fs.getDoc(fs.doc(dbHandle, cursor.path));
  if (!snap.exists()) {
    return null;
  }
  return [snap];
}

export async function buildQuery(
  fs: FirestoreSurface,
  builders: ValueBuilders,
  dbHandle: unknown,
  spec: QuerySpec,
): Promise<unknown> {
  let base: unknown;
  if (spec.source.kind === 'collection') {
    base = fs.collection(dbHandle, spec.source.path);
  } else {
    base = fs.collectionGroup(dbHandle, spec.source.collectionId);
  }

  const nonFilterConstraints: unknown[] = [];
  if (spec.orderBy !== undefined) {
    for (const order of spec.orderBy) {
      nonFilterConstraints.push(
        fs.orderBy(materializeQueryField(builders, order.field), order.dir),
      );
    }
  }

  const cursorBuilders: Array<[CursorSpec | undefined, AnyFn]> = [
    [spec.startAt, fs.startAt],
    [spec.startAfter, fs.startAfter],
    [spec.endAt, fs.endAt],
    [spec.endBefore, fs.endBefore],
  ];
  for (const [cursorSpec, cursorFn] of cursorBuilders) {
    if (cursorSpec !== undefined) {
      const resolved = await resolveCursorArgs(fs, builders, dbHandle, cursorSpec);
      if (resolved !== null) {
        nonFilterConstraints.push(cursorFn(...resolved));
      }
    }
  }

  if (spec.limit !== undefined) {
    nonFilterConstraints.push(fs.limit(spec.limit));
  }
  if (spec.limitToLast !== undefined) {
    nonFilterConstraints.push(fs.limitToLast(spec.limitToLast));
  }

  if (spec.filter !== undefined) {
    const builtFilter = buildFilterConstraint(fs, builders, spec.filter);
    if (spec.filter.kind === 'where') {
      return fs.query(base, builtFilter, ...nonFilterConstraints);
    }
    const compositeQuery = fs.query(base, builtFilter);
    if (nonFilterConstraints.length === 0) {
      return compositeQuery;
    }
    return fs.query(compositeQuery, ...nonFilterConstraints);
  }

  if (nonFilterConstraints.length === 0) {
    return base;
  }
  return fs.query(base, ...nonFilterConstraints);
}

export function serializeDocSnapshot(snap: {
  exists: () => boolean;
  id: string;
  ref: { path: string };
  data: () => unknown;
}): Record<string, unknown> {
  const exists = snap.exists();
  if (!exists) {
    return { exists: false, id: snap.id, path: snap.ref.path, data: null };
  }
  return {
    exists: true,
    id: snap.id,
    path: snap.ref.path,
    data: canonicalizeReadValue(snap.data()),
  };
}

export function serializeQuerySnapshot(snap: {
  size: number;
  empty: boolean;
  docs: Array<{ id: string; ref: { path: string }; data: () => unknown }>;
  docChanges: () => Array<{
    type: string;
    oldIndex: number;
    newIndex: number;
    doc: { id: string; ref: { path: string }; data: () => unknown };
  }>;
}): Record<string, unknown> {
  return {
    size: snap.size,
    empty: snap.empty,
    docs: snap.docs.map((docSnap) => ({
      id: docSnap.id,
      path: docSnap.ref.path,
      data: canonicalizeReadValue(docSnap.data()),
    })),
    changes: snap.docChanges().map((change) => ({
      type: change.type,
      path: change.doc.ref.path,
      oldIndex: change.oldIndex,
      newIndex: change.newIndex,
      data: canonicalizeReadValue(change.doc.data()),
    })),
  };
}
