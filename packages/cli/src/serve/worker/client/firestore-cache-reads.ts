/**
 * Explicit client-cache read execution (`getDocFromCache`, `getDocsFromCache`)
 * for the SharedWorker and Node-hosted WebSocket Firestore planes (`FS-148`).
 */
import { FirebaseError } from 'pyric/app';
import { finishSdkRead } from 'pyric/sandbox/internal';
import type { TargetDescriptor } from '../protocol.js';
import { dataRpc, nextId } from './core.js';
import {
  assertWorkerFirestoreActive,
  hasWorkerCachedPaths,
  isWorkerTargetPathCached,
  markWorkerHandleStarted,
} from './firestore-lifecycle.js';
import {
  buildWorkerOfflineWire,
  isWorkerFirestoreOffline,
  readWorkerCachedDocProjection,
} from './firestore-network.js';
import { assertExecutableQueryDescriptor } from './firestore-query-validation.js';
import type { CollRefHandle, DocRefHandle, QueryHandle } from './handles.js';
import { beginWorkerFirestoreActivity } from './sdk-activity.js';
import {
  makeDocSnapshot,
  makeQuerySnapshot,
  type ClientDocSnapshot,
  type ClientQuerySnapshot,
  type RawDocResult,
  type RawQueryResult,
} from './snapshots.js';
import type { DocumentData } from 'pyric/firestore';

export async function readWorkerDocFromCache<T = DocumentData>(
  ref: DocRefHandle<T>,
): Promise<ClientDocSnapshot<T>> {
  assertWorkerFirestoreActive(ref);
  markWorkerHandleStarted(ref);
  const activity = beginWorkerFirestoreActivity(ref, 'getDocFromCache', 'operation');
  if (!isWorkerTargetPathCached(ref, ref.descriptor.path)) {
    activity.fail();
    throw new FirebaseError(
      'unavailable',
      'Failed to get document from cache. (However, this document may exist on the server.)',
    );
  }
  try {
    const projected = readWorkerCachedDocProjection(ref.port, ref.descriptor.path);
    const metadata = Object.freeze({
      fromCache: true,
      hasPendingWrites: Boolean(projected.result.hasPendingWrites),
    });
    return finishSdkRead(activity, makeDocSnapshot(projected.result, ref.port, ref, metadata));
  } catch (error) {
    activity.fail();
    throw error;
  }
}

export async function readWorkerQueryFromCache(
  source: CollRefHandle | QueryHandle,
): Promise<ClientQuerySnapshot> {
  assertWorkerFirestoreActive(source);
  markWorkerHandleStarted(source);
  const activity = beginWorkerFirestoreActivity(source, 'getDocsFromCache', 'operation');
  try {
    if (source.__kind === 'query') {
      assertExecutableQueryDescriptor(source.descriptor.constraints);
    }
    let sourceDescriptor: TargetDescriptor = (source as QueryHandle).descriptor;
    if (source.__kind === 'coll-ref') {
      sourceDescriptor = (source as CollRefHandle).descriptor;
    }
    if (!hasWorkerCachedPaths(source)) {
      const coldMeta = Object.freeze({ fromCache: true, hasPendingWrites: false });
      return finishSdkRead(
        activity,
        makeQuerySnapshot({ docs: [] }, source.port, source.converter, undefined, sourceDescriptor, coldMeta),
      );
    }
    if (isWorkerFirestoreOffline(source.port) && sourceDescriptor.__ref !== 'query') {
      const offlineResult = buildWorkerOfflineWire(source.port, sourceDescriptor) as RawQueryResult;
      const offlineDocs = offlineResult.docs.filter(
        (d) => d.path !== undefined && isWorkerTargetPathCached(source, d.path),
      );
      const offlineMeta = Object.freeze({
        fromCache: true,
        hasPendingWrites: offlineDocs.some((d) => d.hasPendingWrites === true),
      });
      return finishSdkRead(
        activity,
        makeQuerySnapshot({ docs: offlineDocs }, source.port, source.converter, undefined, sourceDescriptor, offlineMeta),
      );
    }
    const hostResult = (await dataRpc(source.port, {
      t: 'op',
      id: nextId(),
      method: 'getDocs',
      source: sourceDescriptor,
    })) as RawQueryResult;
    const cachedDocs: RawDocResult[] = [];
    for (const hostDoc of hostResult.docs) {
      if (hostDoc.path === undefined || !isWorkerTargetPathCached(source, hostDoc.path)) {
        continue;
      }
      const projected = readWorkerCachedDocProjection(source.port, hostDoc.path);
      if (projected.known) {
        if (projected.result.exists) {
          cachedDocs.push(projected.result);
        }
      } else {
        cachedDocs.push(hostDoc);
      }
    }
    const warmMeta = Object.freeze({
      fromCache: true,
      hasPendingWrites: cachedDocs.some((d) => d.hasPendingWrites === true),
    });
    return finishSdkRead(
      activity,
      makeQuerySnapshot({ docs: cachedDocs }, source.port, source.converter, undefined, sourceDescriptor, warmMeta),
    );
  } catch (error) {
    activity.fail();
    throw error;
  }
}
