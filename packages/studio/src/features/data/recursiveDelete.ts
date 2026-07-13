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
 * document's children, `listDocuments` to enumerate a collection — NOT
 * `getDocs`: a query excludes "missing" parent docs (no stored fields,
 * real descendants), which would orphan everything beneath them — and
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
  handles: Pick<StudioDataHandles, 'listSubcollections' | 'listDocuments'>,
): RecursiveDeleteImpl {
  async function* walkDoc(
    ref: DocumentReference,
    countRef: { n: number },
    phantom = false,
  ): AsyncIterableIterator<RecursiveDeleteProgress> {
    const subIds = await handles.listSubcollections(ref.path);
    for (const collId of subIds) {
      yield* walkCollection(api.collection(ref, collId), countRef);
    }
    // A phantom has no stored doc: the subtree walk above is the whole job,
    // and a delete would be a no-op we'd miscount as a deletion.
    if (phantom) return;
    await api.deleteDoc(ref);
    countRef.n++;
    yield { deletedCount: countRef.n, done: false };
  }

  async function* walkCollection(
    coll: CollectionReference,
    countRef: { n: number },
  ): AsyncIterableIterator<RecursiveDeleteProgress> {
    // The phantom-INCLUSIVE listing, not a `getDocs` query: queries exclude
    // "missing" parent docs, so their descendants would survive the delete.
    const entries = await handles.listDocuments(coll.path);
    for (const entry of entries) {
      const id = entry.path.split('/').pop();
      if (!id) continue;
      yield* walkDoc(api.doc(coll, id), countRef, entry.phantom === true);
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

/** Run a recursive implementation to completion and let failures reject.
 *  The generic UI hook intentionally captures errors as state; Studio's
 *  destructive flows need a rejecting promise so they only navigate away
 *  after the subtree is actually gone. */
export async function deleteRecursively(
  impl: RecursiveDeleteImpl,
  target: DocumentReference | CollectionReference,
): Promise<void> {
  for await (const progress of impl.start(target)) {
    if (progress.done) return;
  }
}
