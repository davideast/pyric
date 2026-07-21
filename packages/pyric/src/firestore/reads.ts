/**
 * `pyric/firestore` — document + query reads.
 *
 * `getDoc` / `getDocs`: resolve the chainable ref under current auth, apply
 * any converter, and hand back a snapshot rehydrated to the modular-SDK
 * shape (see `snapshots.ts`).
 */
import type {
  AdminDocumentSnapshot as ChainDocSnap,
  AdminQuerySnapshot as ChainQuerySnap,
  DocumentData,
} from 'pyric/sandbox/admin-firestore';

import {
  targetOf,
  converterOf,
  tag,
  chainDocFor,
  chainQueryFor,
} from './state.js';
import {
  wrapSandboxDocSnap,
  applyConverterToDocSnap,
  tagSnapshotRefs,
} from './snapshots.js';
import type {
  DocumentReference,
  DocumentSnapshot,
  Query,
  QuerySnapshot,
  QueryDocumentSnapshot,
  FirestoreDataConverter,
} from './types.js';

export async function getDoc<T = DocumentData>(ref: DocumentReference<T>): Promise<DocumentSnapshot<T>> {
  const target = targetOf(ref);
  const conv = converterOf(ref);
  const snap = await chainDocFor(target, ref).get();
  if (conv) {
    return applyConverterToDocSnap(
      snap as unknown as ChainDocSnap,
      conv as FirestoreDataConverter<T>,
      target,
    );
  }
  tagSnapshotRefs(snap, target);
  return wrapSandboxDocSnap<T>(snap as object);
}

export async function getDocs<T = DocumentData>(query: Query<T>): Promise<QuerySnapshot<T>> {
  const target = targetOf(query);
  const conv = converterOf(query);
  const snap = await chainQueryFor(target, query).get();
  if (conv) {
    const c = conv as FirestoreDataConverter<T>;
    const wrappedDocs = (snap as unknown as ChainQuerySnap).docs.map((d) =>
      applyConverterToDocSnap(d as unknown as ChainDocSnap, c, target) as QueryDocumentSnapshot<T>,
    );
    return tag({
      size: wrappedDocs.length,
      empty: wrappedDocs.length === 0,
      docs: wrappedDocs,
    }, target);
  }
  tagSnapshotRefs(snap, target);
  const docs = (snap as unknown as ChainQuerySnap).docs;
  for (const d of docs) wrapSandboxDocSnap(d as object);
  return snap as unknown as QuerySnapshot<T>;
}
