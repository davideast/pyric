/**
 * `TransactionImpl` — Admin-SDK-compat `Transaction` backed by the
 * simulator's `TransactionContext` (`simTx`).
 *
 * Ported from bench's `pilot/src/firestore-wrapper.ts:398-445`.
 *
 * The two `tx.get` overloads dispatch on a structural `isQuery` test
 * (`.where` present on Query and CollectionRef but not DocumentRef).
 * Bench's PR #7 fix: query reads register the touched paths in the
 * tx's read set via `simTx.getAll(...paths)` so the simulator's
 * commit-time read-after-write check sees them, mirroring real
 * Firestore's per-doc read tracking.
 *
 * Read-after-write detection lives in the simulator
 * (`ReadAfterWriteError` thrown from `simTx.get`/`getAll` once
 * `writeStarted` is set). The translation to a typed
 * `FirestoreCompatError { code: 'failed-precondition' }` happens at
 * the `runTransaction` boundary in `firestore.ts` — slice plan's
 * divergence #4-A, locked in the design rationale.
 *
 * Read-path data: timestamps are translated via `translateReadData`
 * just like single-doc and query reads.
 */

import type { Transaction as SimTransaction } from 'pyric/sandbox/internal';
import { translateReadData } from './snapshots.js';
import {
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type Query,
  type QuerySnapshot,
  type Transaction,
} from './types.js';

/**
 * Structural test: is this a Query (or CollectionReference) vs a
 * DocumentReference? Query has `.where`; DocumentReference does not.
 * Used by `TransactionImpl.get` to dispatch its two overloads at
 * runtime — kept structural (rather than `instanceof`) because the
 * caller may have wrapped or proxied the ref.
 */
function isQuery(x: DocumentReference | Query): x is Query {
  return typeof (x as { where?: unknown }).where === 'function';
}

export class TransactionImpl implements Transaction {
  constructor(private readonly simTx: SimTransaction) {}

  get(ref: DocumentReference): Promise<DocumentSnapshot>;
  get(query: Query): Promise<QuerySnapshot>;
  async get(refOrQuery: DocumentReference | Query): Promise<DocumentSnapshot | QuerySnapshot> {
    if (isQuery(refOrQuery)) {
      // Run the query through the wrapper's normal path. In the
      // single-threaded simulator, env.listDocuments and simTx.get see
      // the same state snapshot, so registering reads after-the-fact
      // is consistent.
      const snap = await refOrQuery.get();
      if (snap.size > 0) {
        // Registers the touched paths in the tx's read set so the
        // simulator's commit-time read-after-write check sees them.
        // Throws ReadAfterWriteError if any tx.set/update/delete
        // already happened — preserved at the runTransaction boundary
        // as 'failed-precondition' (divergence #4-A).
        this.simTx.getAll(...snap.docs.map((d) => d.ref.path));
      }
      return snap;
    }
    const txSnap = this.simTx.get(refOrQuery.path);
    const data = txSnap.data();
    if (data === undefined) {
      return {
        id: refOrQuery.id,
        ref: refOrQuery,
        exists: false,
        data: () => undefined,
      };
    }
    const translated = translateReadData(data);
    return {
      id: refOrQuery.id,
      ref: refOrQuery,
      exists: true,
      data: () => translated,
    };
  }

  set(ref: DocumentReference, data: DocumentData): Transaction {
    this.simTx.set(ref.path, data);
    return this;
  }

  update(ref: DocumentReference, data: DocumentData): Transaction {
    this.simTx.update(ref.path, data);
    return this;
  }

  delete(ref: DocumentReference): Transaction {
    this.simTx.delete(ref.path);
    return this;
  }
}
