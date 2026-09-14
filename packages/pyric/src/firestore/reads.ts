/**
 * `pyric/firestore` — document + query reads.
 *
 * `getDoc` / `getDocs`: resolve the chainable ref under current auth, apply
 * any converter, and hand back a snapshot rehydrated to the modular-SDK
 * shape (see `snapshots.ts`).
 */
import { withFirestoreFirebaseError } from './errors.js';
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
import { beginFirestoreActivity } from './sdk-activity.js';
import { finishSdkRead, type SdkActivityHandle } from '../sandbox/internal/sdk-activity.js';

export function getDoc<T = DocumentData>(ref: DocumentReference<T>): Promise<DocumentSnapshot<T>> {
  return readDocumentAs(ref, 'getDoc');
}

/** Keep served aliases on the same backend path while preserving their public name. */
export function readDocumentAs<T = DocumentData>(ref: DocumentReference<T>, method: string): Promise<DocumentSnapshot<T>> {
  return readDocument(ref, beginFirestoreActivity(targetOf(ref), ref, method, 'operation'));
}

/** Shared executor; the public caller supplies its own activity identity. */
export async function readDocument<T = DocumentData>(ref: DocumentReference<T>, activity: SdkActivityHandle): Promise<DocumentSnapshot<T>> {
  const target = targetOf(ref);
  const client = clientStateFor(target);
  client.markStarted();
  try {
    const conv = converterOf(ref);
    const snap = await chainDocFor(target, ref).get();
    client.cachePath(ref.path);
    if (conv) {
      return finishSdkRead(activity, applyConverterToDocSnap(
        snap as unknown as ChainDocSnap,
        conv as FirestoreDataConverter<T>,
        target,
        'document',
      ));
    }
    tagSnapshotRefs(snap, target);
    return finishSdkRead(activity, wrapSandboxDocSnap<T>(snap as object, target));
  } catch (error) {
    activity.fail();
    throw error;
  }
}

export function getDocs<T = DocumentData>(query: Query<T>): Promise<QuerySnapshot<T>> {
  return readQueryAs(query, 'getDocs');
}

/** Keep served aliases on the same backend path while preserving their public name. */
export function readQueryAs<T = DocumentData>(query: Query<T>, method: string): Promise<QuerySnapshot<T>> {
  return readQuery(query, beginFirestoreActivity(targetOf(query), query, method, 'operation'));
}

/** Shared executor; the public caller supplies its own activity identity. */
export async function readQuery<T = DocumentData>(query: Query<T>, activity: SdkActivityHandle): Promise<QuerySnapshot<T>> {
  const target = targetOf(query);
  const client = clientStateFor(target);
  client.markStarted();
  try {
    const conv = converterOf(query);
    const snap = await withFirestoreFirebaseError(() => chainQueryFor(target, query).get());
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
      return finishSdkRead(activity, wrapped);
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
    return finishSdkRead(activity, snap as unknown as QuerySnapshot<T>);
  } catch (error) {
    activity.fail();
    throw error;
  }
}
