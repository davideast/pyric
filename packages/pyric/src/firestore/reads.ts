/**
 * `pyric/firestore` — document + query reads.
 *
 * `getDoc` / `getDocs`: resolve the chainable ref under current auth, apply
 * any converter, and hand back a snapshot rehydrated to the modular-SDK
 * shape (see `snapshots.ts`).
 */
import { withFirestoreFirebaseError } from './errors.js';
import { FirebaseError } from '../sandbox/internal/firebase-error.js';
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
import { buildQuerySnapshotToJson } from './ssr-snapshots.js';
import type {
  DocumentReference,
  DocumentSnapshot,
  Query,
  QuerySnapshot,
  QueryDocumentSnapshot,
  FirestoreDataConverter,
} from './types.js';
import { clientStateFor } from './client-state.js';
import { forEachDocument } from './sandbox/for-each-document.js';
import { computeDocumentChanges, createDocChanges } from './sandbox/snapshot-listeners.js';
import { beginFirestoreActivity } from './sdk-activity.js';
import { finishSdkRead, type SdkActivityHandle } from '../sandbox/internal/sdk-activity.js';

export function getDoc<T = DocumentData>(ref: DocumentReference<T>): Promise<DocumentSnapshot<T>> {
  return readDocumentAs(ref, 'getDoc');
}

/** Keep served aliases on the same backend path while preserving their public name. */
export async function readDocumentAs<T = DocumentData>(ref: DocumentReference<T>, method: string): Promise<DocumentSnapshot<T>> {
  return readDocument(ref, beginFirestoreActivity(targetOf(ref), ref, method, 'operation'));
}

/** Shared executor; the public caller supplies its own activity identity. */
export async function readDocument<T = DocumentData>(ref: DocumentReference<T>, activity: SdkActivityHandle): Promise<DocumentSnapshot<T>> {
  const target = targetOf(ref);
  const client = clientStateFor(target);
  const missingDb = client.syncMissingDatabaseOfflineState(target, ref.path);
  try {
    const conv = converterOf(ref);
    if (!client.isNetworkEnabled()) {
      const projected = client.overlay.projectDoc(ref.path);
      if (projected.known) {
        const offlineSnap = client.overlay.buildOfflineDocSnapshot(ref.path);
        client.cachePath(ref.path);
        if (conv) {
          return finishSdkRead(activity, applyConverterToDocSnap(
            offlineSnap as unknown as ChainDocSnap,
            conv as FirestoreDataConverter<T>,
            target,
            'document',
          ));
        }
        tagSnapshotRefs(offlineSnap, target);
        return finishSdkRead(activity, wrapSandboxDocSnap<T>(offlineSnap as object, target));
      }
      if (missingDb) {
        throw new FirebaseError('unavailable', 'Failed to get document because the client is offline.');
      }
    }
    const snap = await withFirestoreFirebaseError(() => chainDocFor(target, ref).get());
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
export async function readQueryAs<T = DocumentData>(query: Query<T>, method: string): Promise<QuerySnapshot<T>> {
  return readQuery(query, beginFirestoreActivity(targetOf(query), query, method, 'operation'));
}

/** Shared executor; the public caller supplies its own activity identity. */
export async function readQuery<T = DocumentData>(query: Query<T>, activity: SdkActivityHandle): Promise<QuerySnapshot<T>> {
  const target = targetOf(query);
  const client = clientStateFor(target);
  const missingDb = client.syncMissingDatabaseOfflineState(target);
  try {
    if (missingDb) {
      throw new FirebaseError('unavailable', 'Failed to get document because the client is offline.');
    }
    const conv = converterOf(query);
    const snap = await withFirestoreFirebaseError(() => chainQueryFor(target, query).get());
    const rawDocs = (snap as unknown as ChainQuerySnap).docs;
    if (typeof (snap as { docChanges?: unknown }).docChanges !== 'function') {
      const rawChanges = computeDocumentChanges(
        undefined,
        rawDocs.map((doc) => ({ path: doc.ref.path })),
        rawDocs,
        () => false,
        () => rawDocs[0]!,
      );
      Object.defineProperty(snap, 'docChanges', {
        value: createDocChanges(rawChanges, false),
        configurable: true,
      });
    }
    client.cacheQuery(query as object);
    if (conv) {
      const c = conv as FirestoreDataConverter<T>;
      const wrappedDocs = rawDocs.map((d) =>
        applyConverterToDocSnap(
          d as unknown as ChainDocSnap,
          c,
          target,
          'query-child',
        ),
      ) as unknown as QuerySnapshot<T>['docs'];
      const changes = computeDocumentChanges(
        undefined,
        wrappedDocs.map((doc) => ({ path: doc.ref.path })),
        [...wrappedDocs],
        () => false,
        () => wrappedDocs[0] as QueryDocumentSnapshot<T>,
      );
      const wrapped = tag({
        query,
        size: wrappedDocs.length,
        empty: wrappedDocs.length === 0,
        docs: wrappedDocs,
        forEach: forEachDocument(wrappedDocs),
        docChanges: createDocChanges(changes, false),
        metadata: client.querySnapshotMetadata(),
        toJSON: buildQuerySnapshotToJson({ docs: wrappedDocs }, target, query as object),
      }, target);
      for (const document of wrappedDocs) client.cachePath(document.ref.path);
      recordQuerySnapshot(wrapped, snap as object, target, query as object, 'read');
      return finishSdkRead(activity, wrapped);
    }
    tagSnapshotRefs(snap, target);
    for (const d of rawDocs) {
      client.cachePath(d.ref.path);
      wrapSandboxDocSnap(d as object, target);
    }
    Object.defineProperty(snap, 'query', {
      value: query,
      configurable: true,
      enumerable: true,
    });
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
