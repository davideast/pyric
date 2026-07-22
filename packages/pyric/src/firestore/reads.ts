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
  recordQuerySnapshot,
} from './snapshots.js';
import type {
  DocumentReference,
  DocumentSnapshot,
  Query,
  QuerySnapshot,
  QueryDocumentSnapshot,
  FirestoreDataConverter,
} from './types.js';
import { clientStateFor } from './client-state.js';

export async function getDoc<T = DocumentData>(ref: DocumentReference<T>): Promise<DocumentSnapshot<T>> {
  const target = targetOf(ref);
  const client = clientStateFor(target);
  client.markStarted();
  const conv = converterOf(ref);
  const snap = await chainDocFor(target, ref).get();
  client.cachePath(ref.path);
  if (conv) {
    return applyConverterToDocSnap(
      snap as unknown as ChainDocSnap,
      conv as FirestoreDataConverter<T>,
      target,
      'document',
    );
  }
  tagSnapshotRefs(snap, target);
  return wrapSandboxDocSnap<T>(snap as object, target);
}

export async function getDocs<T = DocumentData>(query: Query<T>): Promise<QuerySnapshot<T>> {
  const target = targetOf(query);
  const client = clientStateFor(target);
  client.markStarted();
  const conv = converterOf(query);
  const snap = await chainQueryFor(target, query).get();
  client.cacheQuery(query as object);
  if (conv) {
    const c = conv as FirestoreDataConverter<T>;
    const wrappedDocs = (snap as unknown as ChainQuerySnap).docs.map((d) =>
      applyConverterToDocSnap(
        d as unknown as ChainDocSnap,
        c,
        target,
        'query-child',
      ) as QueryDocumentSnapshot<T>,
    );
    const wrapped = tag({
      size: wrappedDocs.length,
      empty: wrappedDocs.length === 0,
      docs: wrappedDocs,
      metadata: client.querySnapshotMetadata(),
    }, target);
    for (const document of wrappedDocs) client.cachePath(document.ref.path);
    recordQuerySnapshot(wrapped, snap as object, target, query as object, 'read');
    return wrapped;
  }
  tagSnapshotRefs(snap, target);
  const docs = (snap as unknown as ChainQuerySnap).docs;
  for (const d of docs) {
    client.cachePath(d.ref.path);
    wrapSandboxDocSnap(d as object, target);
  }
  Object.defineProperty(snap, 'metadata', {
    value: client.querySnapshotMetadata(),
    configurable: true,
  });
  recordQuerySnapshot(snap as object, snap as object, target, query as object, 'read');
  return snap as unknown as QuerySnapshot<T>;
}
