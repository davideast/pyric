/**
 * Admin-shaped one-shot snapshots for the remote arm — `getDoc`/`getDocs`
 * results decoded from the wire into `DocumentSnapshot`/`QuerySnapshot`.
 */

import type {
  DocumentReference,
  DocumentSnapshot,
  QueryDocumentSnapshot,
  QuerySnapshot,
} from 'pyric/sandbox/admin-compat';
import type { RemoteArm } from './channel.js';
import { decodeDocData } from './value-codec.js';
import { makeDocRef } from './doc-ref.js';
import type { WireDocSnap, WireQuerySnap } from './wire-types.js';
import { getSnapshotField } from '../../../firestore/sandbox/admin-compat/field-path.js';
import { cloneSnapshotValue } from '../../../firestore/sandbox/admin-compat/read-translation.js';
import { forEachDocument } from '../../../firestore/sandbox/for-each-document.js';
import {
  computeDocumentChanges,
  createDocChanges,
} from '../../../firestore/sandbox/snapshot-listeners.js';

export function makeDocumentSnapshot(ref: DocumentReference, wire: WireDocSnap): DocumentSnapshot {
  const data = wire.exists && wire.data ? decodeDocData(wire.data) : undefined;
  return {
    id: ref.id,
    ref,
    exists: wire.exists,
    data: () => (data !== undefined ? cloneSnapshotValue(data) : undefined),
    get: (fieldPath) => cloneSnapshotValue(getSnapshotField(data, fieldPath)),
  };
}

export function makeQuerySnapshot(
  arm: RemoteArm,
  wire: WireQuerySnap,
): QuerySnapshot {
  const rows: Array<{ path: string; data: Record<string, unknown> }> = [];
  const docs: QueryDocumentSnapshot[] = wire.docs.map((row) => {
    const path = row.path ?? row.id;
    const ref = makeDocRef(arm, path);
    const data = row.data ? decodeDocData(row.data) : {};
    rows.push({ path, data });
    return {
      id: ref.id,
      ref,
      exists: true,
      data: () => cloneSnapshotValue(data),
      get: (fieldPath) => cloneSnapshotValue(getSnapshotField(data, fieldPath)),
    };
  });
  const changes = computeDocumentChanges(
    undefined,
    rows,
    docs,
    () => false,
    () => docs[0]!,
  );
  return {
    size: docs.length,
    empty: docs.length === 0,
    docs,
    forEach: forEachDocument(docs),
    docChanges: createDocChanges(changes, false),
  };
}
