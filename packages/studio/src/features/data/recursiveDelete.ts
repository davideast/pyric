/**
 * Recursive delete (F2 Console-parity): "Delete collection" / "Delete
 * document" both need to walk and remove an entire subtree — a document's
 * subcollections, their documents, THOSE documents' subcollections, etc.
 *
 * There is no dedicated recursive-delete op on the sandbox worker's RPC
 * surface (`FirestoreApi` is `getDoc`/`getDocs`/`setDoc`/`deleteDoc`/...
 * only — see `@pyric/ui/firestore`'s `firestoreApi.ts`). Rather than add a
 * new worker message type for this, the walk is done CLIENT-SIDE against
 * the existing primitives: `listSubcollections` (already on
 * `StudioDataHandles`, sync in-process / async over the worker) to find a
 * document's children, `getDocs` to list a collection's documents, and
 * `deleteDoc` to remove leaves. This keeps the sandbox/worker protocol
 * untouched while still giving the panel a real recursive delete.
 *
 * Implements `@pyric/ui/firestore`'s `RecursiveDeleteImpl` so the panel can
 * drive it through the library's `<DeleteWithConfirm>` + `useRecursiveDelete`
 * (confirm dialog + progress reporting for free, no need to reinvent either).
 */

import type {
  CollectionReference,
  DocumentReference,
} from 'pyric/firestore';
import type { FirestoreApi } from '@pyric/ui/firestore';
import type {
  RecursiveDeleteImpl,
  RecursiveDeleteProgress,
} from '@pyric/ui/firestore/hooks';
import type { StudioDataHandles } from './sandbox.js';

/** A document path has an EVEN segment count (coll/doc/coll/doc/...); a
 *  collection path has an ODD one. Same convention `validateLeaf`'s
 *  reference check uses. */
function isDocumentPath(path: string): boolean {
  return path.split('/').filter(Boolean).length % 2 === 0;
}

export function makeRecursiveDeleteImpl(
  api: FirestoreApi,
  handles: Pick<StudioDataHandles, 'listSubcollections'>,
): RecursiveDeleteImpl {
  async function* walkDoc(
    ref: DocumentReference,
    countRef: { n: number },
  ): AsyncIterableIterator<RecursiveDeleteProgress> {
    const subIds = await handles.listSubcollections(ref.path);
    for (const collId of subIds) {
      yield* walkCollection(api.collection(ref, collId), countRef);
    }
    await api.deleteDoc(ref);
    countRef.n++;
    yield { deletedCount: countRef.n, done: false };
  }

  async function* walkCollection(
    coll: CollectionReference,
    countRef: { n: number },
  ): AsyncIterableIterator<RecursiveDeleteProgress> {
    // `getDocs` wants a `Query`, not a bare `CollectionReference` — wrap it
    // with zero constraints (same shape `useDocumentList`'s paged fetch uses).
    const snap = await api.getDocs(api.query(coll));
    for (const d of snap.docs) {
      const ref = (d as unknown as { ref: DocumentReference }).ref;
      yield* walkDoc(ref, countRef);
    }
  }

  return {
    async *start(target) {
      const countRef = { n: 0 };
      if (isDocumentPath(target.path)) {
        yield* walkDoc(target as DocumentReference, countRef);
      } else {
        yield* walkCollection(target as CollectionReference, countRef);
      }
      yield { deletedCount: countRef.n, done: true };
    },
  };
}
