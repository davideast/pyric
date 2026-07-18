/**
 * `DocumentReference`/`CollectionReference` construction for the remote
 * arm — thin wire-backed handles that dispatch reads/writes through
 * `armOp` and delegate collection-shaped state to `makeQuery`.
 */

import type {
  CollectionReference,
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
  OperationOptions,
  SetOptions,
} from 'pyric/sandbox/admin-compat';
import {
  isCollectionPath,
  lastSegment,
  parentCollectionPath,
} from '../../../firestore/sandbox/admin-compat/paths.js';
import { generateAutoId } from '../../../firestore/sandbox/auto-id.js';
import { armOp, type RemoteArm } from './channel.js';
import { invalidArgument } from './errors.js';
import { encodeWriteData } from './value-codec.js';
import { makeDocumentSnapshot } from './snapshots.js';
import { makeQuery } from './query.js';
import {
  chainableOnSnapshot,
  REMOTE_SNAPSHOT_REGISTRAR,
  registerRemoteListener,
  type RemoteSnapshotRegistrar,
} from './listeners.js';
import type { WireDocSnap } from './wire-types.js';

export function makeCollectionRef(arm: RemoteArm, path: string): CollectionReference {
  const base = makeQuery(arm, {
    source: { __ref: 'collection', path },
    filters: [],
    orders: [],
    limitFromEnd: false,
  });
  const coll: CollectionReference = Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
    id: lastSegment(path),
    path,
    doc(id?: string): DocumentReference {
      const finalId = id ?? generateAutoId();
      return makeDocRef(arm, `${path}/${finalId}`);
    },
    async add(data: DocumentData, _opts?: OperationOptions): Promise<DocumentReference> {
      // The worker mints the id (`addDoc`), so creation is one round-trip
      // and the id is authoritative from the shared sandbox.
      const res = (await armOp(arm, {
        method: 'addDoc',
        collectionPath: path,
        data: encodeWriteData(data),
      })) as { id: string; path: string };
      return makeDocRef(arm, res.path);
    },
  });
  return coll;
}

export function makeDocRef(arm: RemoteArm, path: string): DocumentReference {
  const ref: DocumentReference & {
    [REMOTE_SNAPSHOT_REGISTRAR]: RemoteSnapshotRegistrar;
    onSnapshot: typeof chainableOnSnapshot;
  } = {
    id: lastSegment(path),
    path,
    get parent(): CollectionReference {
      return makeCollectionRef(arm, parentCollectionPath(path));
    },
    collection(name: string): CollectionReference {
      const sub = `${path}/${name}`;
      if (!isCollectionPath(sub)) {
        throw invalidArgument(`collection path must have an odd number of segments: ${sub}`);
      }
      return makeCollectionRef(arm, sub);
    },
    async get(_opts?: OperationOptions): Promise<DocumentSnapshot> {
      const wire = (await armOp(arm, { method: 'getDoc', path })) as WireDocSnap;
      return makeDocumentSnapshot(ref, wire);
    },
    async set(data: DocumentData, options?: SetOptions): Promise<void> {
      await armOp(arm, {
        method: 'setDoc',
        path,
        data: encodeWriteData(data),
        ...(setOptionsForWire(options) ? { options: setOptionsForWire(options) } : {}),
      });
    },
    async update(data: DocumentData, _opts?: OperationOptions): Promise<void> {
      await armOp(arm, { method: 'updateDoc', path, data: encodeWriteData(data) });
    },
    async delete(_opts?: OperationOptions): Promise<void> {
      await armOp(arm, { method: 'deleteDoc', path });
    },
    [REMOTE_SNAPSHOT_REGISTRAR]: (options, onNext, onError) =>
      registerRemoteListener(arm, { __ref: 'doc', path }, options, onNext, onError),
    onSnapshot: chainableOnSnapshot,
  };
  return ref;
}

function setOptionsForWire(
  options?: SetOptions,
): { merge?: boolean; mergeFields?: string[] } | undefined {
  if (!options) return undefined;
  const wire: { merge?: boolean; mergeFields?: string[] } = {};
  if (options.merge !== undefined) wire.merge = options.merge;
  if (options.mergeFields !== undefined) wire.mergeFields = [...options.mergeFields];
  return wire.merge !== undefined || wire.mergeFields !== undefined ? wire : undefined;
}
