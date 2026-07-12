/**
 * `pyric/firestore` — document + query reads.
 *
 * `getDoc` / `getDocs`: resolve the chainable ref under current auth, apply
 * any converter, and hand back a snapshot rehydrated to Firebase's
 * modular-SDK shape (see `snapshots.ts`). Prod handles forward to
 * `firebase/firestore`.
 */
import * as fb from 'firebase/firestore';
import type {
  AdminDocumentSnapshot as ChainDocSnap,
  AdminQuerySnapshot as ChainQuerySnap,
  DocumentData,
} from 'pyric/sandbox/admin-firestore';

import {
  targetOf,
  isSandboxKind,
  converterOf,
  chainDocFor,
  chainQueryFor,
  asFbDoc,
  asFbQuery,
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
  if (isSandboxKind(target)) {
    const conv = converterOf(ref);
    const snap = await chainDocFor(target, ref).get();
    if (conv) {
      return applyConverterToDocSnap(
        snap as unknown as ChainDocSnap,
        conv as FirestoreDataConverter<T>,
      );
    }
    // Normalize `.exists` to method form + tag the snap's ref so
    // consumers get Firebase-modular-SDK shape uniformly.
    tagSnapshotRefs(snap, target);
    // Wrap .data() to translate `pyric/rules` wrappers
    // (Bytes / LatLng) into `firebase/firestore` types so reads match
    // prod's instanceof semantics. Closes firestore #109 + #110.
    return wrapSandboxDocSnap<T>(snap as object);
  }
  return fb.getDoc(asFbDoc(ref)) as unknown as Promise<DocumentSnapshot<T>>;
}

export async function getDocs<T = DocumentData>(query: Query<T>): Promise<QuerySnapshot<T>> {
  const target = targetOf(query);
  if (isSandboxKind(target)) {
    const conv = converterOf(query);
    const snap = await chainQueryFor(target, query).get();
    if (conv) {
      const c = conv as FirestoreDataConverter<T>;
      const wrappedDocs = (snap as unknown as ChainQuerySnap).docs.map((d) =>
        applyConverterToDocSnap(d as unknown as ChainDocSnap, c) as QueryDocumentSnapshot<T>,
      );
      return {
        size: wrappedDocs.length,
        empty: wrappedDocs.length === 0,
        docs: wrappedDocs,
      };
    }
    // Normalize each doc's `.exists` + tag the doc refs so consumer
    // code targeting Firebase's modular SDK works uniformly.
    tagSnapshotRefs(snap, target);
    // Wrap each doc snap's .data() to translate rules-wrappers to
    // `firebase/firestore` types — same parity hop as `getDoc` above.
    const docs = (snap as unknown as ChainQuerySnap).docs;
    for (const d of docs) wrapSandboxDocSnap(d as object);
    return snap as unknown as QuerySnapshot<T>;
  }
  return fb.getDocs(asFbQuery(query)) as unknown as Promise<QuerySnapshot<T>>;
}
