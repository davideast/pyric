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

export function makeDocumentSnapshot(ref: DocumentReference, wire: WireDocSnap): DocumentSnapshot {
  const data = wire.exists && wire.data ? decodeDocData(wire.data) : undefined;
  return {
    id: ref.id,
    ref,
    exists: wire.exists,
    data: () => data,
  };
}

export function makeQuerySnapshot(
  arm: RemoteArm,
  wire: WireQuerySnap,
): QuerySnapshot {
  const docs: QueryDocumentSnapshot[] = wire.docs.map((row) => {
    const path = row.path ?? row.id;
    const ref = makeDocRef(arm, path);
    const data = row.data ? decodeDocData(row.data) : {};
    return {
      id: ref.id,
      ref,
      exists: true,
      data: () => data,
    };
  });
  return {
    size: docs.length,
    empty: docs.length === 0,
    docs,
    forEach(callback: (snap: QueryDocumentSnapshot) => void): void {
      docs.forEach((d) => callback(d));
    },
  };
}
