/**
 * `Transaction` for the remote arm.
 *
 * TRANSACTIONS: the worker exposes no interactive transaction session; the
 * protocol is optimistic — every `tx.get` is an ordinary `getDoc`/`getDocs`
 * op recorded into a client-held read-set, and ONE `txnCommit` op ships
 * `{ reads, writes }`. The worker re-reads each path inside a real sandbox
 * transaction and compares SERIALIZED JSON STRINGS. The read-set therefore
 * echoes the worker's ORIGINAL `SerializedDocData.json` strings verbatim —
 * re-serializing rehydrated data on this side would risk cross-process
 * key-order/format drift and phantom aborts (livelock under retry). On
 * `{ code: 'aborted' }` the update function is re-run with a fresh
 * transaction, up to {@link TXN_MAX_ATTEMPTS} attempts (the worker client's
 * model, which itself matches the Firestore SDK default).
 */

import { SandboxError } from 'pyric/sandbox';
import type {
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
  Query,
  QuerySnapshot,
  Transaction,
} from 'pyric/sandbox/admin-compat';
import { READ_AFTER_WRITE_MESSAGE } from '../../../firestore/sandbox/transaction-types.js';
import { armOp, type RemoteArm } from './channel.js';
import { encodeWriteData } from './value-codec.js';
import { makeDocumentSnapshot, makeQuerySnapshot } from './snapshots.js';
import { buildDescriptor, queryStateOf, validateExecutable, type QueryState } from './query.js';
import type { WireDocSnap, WireQuerySnap, WireTxnRead, WireWrite } from './wire-types.js';

/** Matches the worker client's retry cap (and the Firestore SDK default). */
const TXN_MAX_ATTEMPTS = 5;

export async function runRemoteTransaction<R>(
  arm: RemoteArm,
  fn: (tx: Transaction) => Promise<R> | R,
): Promise<R> {
  for (let attempt = 0; attempt < TXN_MAX_ATTEMPTS; attempt++) {
    // Fresh read-set + write buffer per attempt.
    const reads: WireTxnRead[] = [];
    const writes: WireWrite[] = [];

    // READS-BEFORE-WRITES: the local arm's engine transaction throws
    // `failed-precondition` (ReadAfterWriteError) when a read follows any
    // write — the Admin SDK contract. The remote arm buffers writes
    // client-side, so without this gate a `tx.get` after `tx.set` would
    // issue a plain getDoc against PRE-transaction state and commit
    // silently on stale data. Enforce the same contract, same message.
    const assertReadsAllowed = (): void => {
      if (writes.length > 0) {
        throw new SandboxError('failed-precondition', READ_AFTER_WRITE_MESSAGE);
      }
    };

    const tx: Transaction = {
      // Overloaded on the surface (doc ref vs query); runtime dispatch on
      // the remote query brand — mirrors the local structural `isQuery`.
      get(refOrQuery: DocumentReference | Query): Promise<never> {
        assertReadsAllowed();
        const state = queryStateOf(refOrQuery);
        if (state !== undefined) {
          return txGetQuery(state) as Promise<never>;
        }
        return txGetDoc(refOrQuery as DocumentReference) as Promise<never>;
      },
      set(ref: DocumentReference, data: DocumentData): Transaction {
        writes.push({ method: 'set', path: ref.path, data: encodeWriteData(data) });
        return tx;
      },
      update(ref: DocumentReference, data: DocumentData): Transaction {
        writes.push({ method: 'update', path: ref.path, data: encodeWriteData(data) });
        return tx;
      },
      delete(ref: DocumentReference): Transaction {
        writes.push({ method: 'delete', path: ref.path });
        return tx;
      },
    };

    async function txGetDoc(ref: DocumentReference): Promise<DocumentSnapshot> {
      const wire = (await armOp(arm, { method: 'getDoc', path: ref.path })) as WireDocSnap;
      // READ-SET INVARIANT: record the worker's ORIGINAL serialized
      // envelope verbatim. The worker validates by re-serializing the
      // current doc IN ITS OWN process and comparing JSON strings —
      // echoing its bytes back is what keeps the comparison deterministic
      // (re-serializing rehydrated data here would phantom-abort).
      reads.push({
        path: wire.path ?? ref.path,
        data: wire.exists && wire.data ? wire.data : null,
      });
      return makeDocumentSnapshot(ref, wire);
    }

    async function txGetQuery(state: QueryState): Promise<QuerySnapshot> {
      validateExecutable(state);
      const wire = (await armOp(arm, {
        method: 'getDocs',
        source: buildDescriptor(state),
      })) as WireQuerySnap;
      // Register every returned doc in the read-set (the local arm's
      // `simTx.getAll` registration) — again echoing the original bytes.
      for (const row of wire.docs) {
        reads.push({ path: row.path ?? row.id, data: row.data ?? null });
      }
      return makeQuerySnapshot(arm, wire);
    }

    const result = await fn(tx);

    try {
      await armOp(arm, { method: 'txnCommit', reads, writes });
      return result;
    } catch (err) {
      if (err instanceof SandboxError && err.code === 'aborted') {
        continue; // read-set conflict — re-run fn with fresh reads
      }
      throw err;
    }
  }

  throw new SandboxError(
    'aborted',
    `Transaction failed after ${TXN_MAX_ATTEMPTS} attempts due to repeated conflicts. ` +
      'Another writer is concurrently updating the same documents.',
  );
}
