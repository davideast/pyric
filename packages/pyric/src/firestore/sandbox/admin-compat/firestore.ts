/**
 * `FirestoreImpl` — top-level Admin-SDK-compat handle backed by a
 * `LocalEnvironment`.
 *
 * Path-shape validation lives at the input boundary so a typo'd path
 * surfaces as `'invalid-argument'` rather than a downstream
 * `'unimplemented'`/`'permission-denied'` blur. Slice 4 wires the
 * remaining method bodies (batch, runTransaction).
 *
 * `runTransaction` carries two locked translations:
 *
 *   - **Divergence #4-A:** the simulator throws `ReadAfterWriteError`
 *     (a plain `Error` subclass carrying `.simError`) when a tx reads
 *     after writing. Translate the throw into a typed
 *     `FirestoreCompatError { code: 'failed-precondition' }` so
 *     callers can `if (e.code === 'failed-precondition')` without
 *     instanceof-checking against an SDK-internal class.
 *
 *   - **Divergence #4-B:** the simulator's `transaction()` returns
 *     `TransactionResult.allowed === false` (with a typed `error`)
 *     when a queued write fails at commit (e.g., `tx.create` on an
 *     existing doc). Surface the typed error directly so the
 *     `'already-exists'` code reaches the caller.
 *
 * The `await` on the env.transaction call is load-bearing: bench
 * wrapper line 195 documents that without it, an async callback
 * leaves `result` as a Promise object whose `.allowed` is undefined,
 * which we'd then misread as a denial.
 *
 * See the design rationale for slice contracts.
 */

import type { LocalEnvironment } from 'pyric/sandbox/internal';
import type { EventProvenance } from '../../../sandbox/types/events.js';
import { makeError } from 'pyric/sandbox/internal';
import {
  ReadAfterWriteError,
  TransactionAttemptsExhaustedError,
} from 'pyric/sandbox/internal';
import { isCollectionPath, isDocumentPath } from './paths.js';
import { CollectionGroupQueryImpl } from './collection-group-query.js';
import { CollectionRefImpl, createDocumentRef } from './collection-ref.js';
import { WriteBatchImpl } from './batch.js';
import { TransactionImpl } from './transaction.js';
import {
  FirestoreCompatError,
  type AuthContext,
  type CollectionReference,
  type DocumentReference,
  type Firestore,
  type OperationOptions,
  type Query,
  type Transaction,
  type WriteBatch,
} from './types.js';

export class FirestoreImpl implements Firestore {
  constructor(
    private readonly env: LocalEnvironment,
    private readonly auth: AuthContext,
    // Studio admin lens (Gap #2): when true, every op produced by this
    // handle (and the refs/batch/tx it spawns) carries `bypassRules`, so
    // the LocalEnvironment skips rule evaluation. Threaded down to each
    // child impl alongside `auth`. Default false → rules enforced.
    private readonly bypassRules: boolean = false,
    private readonly provenance?: EventProvenance,
  ) {}

  collection(path: string): CollectionReference {
    if (!isCollectionPath(path)) {
      throw new FirestoreCompatError(
        makeError(
          'invalid-argument',
          `collection path must have an odd number of segments: ${path}`,
        ),
      );
    }
    return new CollectionRefImpl(this.env, this.auth, path, this.bypassRules);
  }

  doc(path: string): DocumentReference {
    if (!isDocumentPath(path)) {
      throw new FirestoreCompatError(
        makeError(
          'invalid-argument',
          `document path must have an even number of segments: ${path}`,
        ),
      );
    }
    return createDocumentRef(this.env, this.auth, path, this.bypassRules);
  }

  collectionGroup(collectionId: string): Query {
    if (collectionId.length === 0 || collectionId.includes('/')) {
      throw new FirestoreCompatError(
        makeError(
          'invalid-argument',
          `collection group id must be a single non-empty segment with no '/': ${collectionId}`,
        ),
      );
    }
    return new CollectionGroupQueryImpl({
      env: this.env,
      auth: this.auth,
      collectionId,
      bypassRules: this.bypassRules,
    });
  }

  batch(): WriteBatch {
    return new WriteBatchImpl(this.env, this.auth, this.bypassRules);
  }

  async runTransaction<R>(
    fn: (tx: Transaction) => Promise<R> | R,
    opts?: OperationOptions,
  ): Promise<R> {
    let result;
    try {
      // The await is load-bearing: see header for the bench-line-195
      // note. Sync-callback path collapses through the same await with
      // no functional difference.
      result = await this.env.transaction<R>(
        (simTx) => {
          const tx = new TransactionImpl(simTx);
          return fn(tx) as R;
        },
        {
          auth: opts?.auth !== undefined ? opts.auth : this.auth,
          bypassRules: this.bypassRules,
          provenance: this.provenance,
          maxAttempts: opts?.maxAttempts,
        },
      );
    } catch (e) {
      // Divergence #4-A: ReadAfterWriteError → typed
      // 'failed-precondition'. Other throws (callback throws, sentinel
      // resolution errors that escape to here) propagate untouched —
      // they aren't wrapper-translatable.
      if (e instanceof ReadAfterWriteError) {
        throw new FirestoreCompatError(e.simError);
      }
      if (e instanceof TransactionAttemptsExhaustedError) {
        throw new FirestoreCompatError(e.simError);
      }
      throw e;
    }
    if (!result.allowed) {
      // Divergence #4-B (and the broader denial case): the simulator
      // attaches a typed `error` to any non-allowed result. Surface
      // it directly so codes like 'already-exists' reach the caller.
      if (result.error) {
        throw new FirestoreCompatError(result.error);
      }
      // Defensive — should be unreachable under Item 6 invariant.
      const denied = result.writes.find((w) => !w.allowed);
      const msg = denied?.debugMessages.join('; ') ?? 'transaction denied at commit';
      throw new FirestoreCompatError(
        makeError('permission-denied', `transaction failed: ${msg}`),
      );
    }
    return result.returnValue as R;
  }
}
