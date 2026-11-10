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

import {
  ReadAfterWriteError,
  RetryableTransactionConflictError,
  type Transaction as SimTransaction,
} from 'pyric/sandbox/internal';
import { LocalState, type DocStore } from '../local-state.js';
import { makeDocSnapshot } from './snapshots.js';
import { normalizeMergeFields, updateFieldsData } from '../update-fields.js';
import { parseAdminUpdateArguments, type FieldPath } from './field-path.js';
import {
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type Query,
  type QuerySnapshot,
  type SetOptions,
  type Transaction,
} from './types.js';

/**
 * Internal retry signal when a rules-enforced transactional query's matched
 * document set changed before commit.
 */
export class QuerySetConflictError extends RetryableTransactionConflictError {
  constructor() {
    super();
    this.message = 'A query read in the transaction changed before commit.';
    this.name = 'QuerySetConflictError';
  }
}

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

type TransactionalQuery = Query & {
  getInTransaction?: (
    pinnedStore: DocStore,
    onExecuted: (
      checkLiveConflict: () => string[] | null,
      matchedPaths: readonly string[],
    ) => void,
  ) => Promise<QuerySnapshot>;
};

export class TransactionImpl implements Transaction {
  private pinnedStoreCache?: DocStore;
  private writeStarted = false;
  private readonly bufferedWrites: Array<() => void> = [];
  private readonly queryChecks: Array<() => string[] | null> = [];

  constructor(
    private readonly simTx: SimTransaction,
    private readonly pinnedSnapshot: Record<string, DocumentData> = {},
    private readonly bypassRules = false,
  ) {}

  private getPinnedStore(): DocStore {
    if (this.pinnedStoreCache === undefined) {
      this.pinnedStoreCache = new LocalState({}, new Map(Object.entries(this.pinnedSnapshot)));
    }
    return this.pinnedStoreCache;
  }

  private assertReadsAllowed(): void {
    if (this.writeStarted) {
      throw new ReadAfterWriteError();
    }
    this.simTx.getAll();
  }

  get(ref: DocumentReference): Promise<DocumentSnapshot>;
  get(query: Query): Promise<QuerySnapshot>;
  async get(refOrQuery: DocumentReference | Query): Promise<DocumentSnapshot | QuerySnapshot> {
    this.assertReadsAllowed();
    const readsQuery = isQuery(refOrQuery);
    if (readsQuery) {
      const txQuery = refOrQuery as TransactionalQuery;
      if (typeof txQuery.getInTransaction === 'function') {
        return txQuery.getInTransaction(
          this.getPinnedStore(),
          (checkLiveConflict, matchedPaths) => {
            if (matchedPaths.length > 0) {
              this.simTx.getAll(...matchedPaths);
            }
            this.queryChecks.push(checkLiveConflict);
          },
        );
      }
      const snap = await refOrQuery.get();
      if (snap.size > 0) {
        this.simTx.getAll(...snap.docs.map((d) => d.ref.path));
      }
      return snap;
    }
    const txSnap = this.simTx.get(refOrQuery.path);
    const data = txSnap.data();
    return makeDocSnapshot(refOrQuery, data);
  }

  create(ref: DocumentReference, data: DocumentData): Transaction {
    const path = ref.path;
    this.writeStarted = true;
    this.bufferedWrites.push(() => {
      this.simTx.create(path, data);
    });
    return this;
  }

  set(ref: DocumentReference, data: DocumentData, options?: SetOptions): Transaction {
    const path = ref.path;
    const mergeFields = options?.mergeFields;
    const hasFieldMask = mergeFields !== undefined;
    if (hasFieldMask) {
      const normalized = normalizeMergeFields(mergeFields);
      this.writeStarted = true;
      this.bufferedWrites.push(() => {
        this.simTx.set(path, data, { mergeFields: normalized });
      });
      return this;
    }
    const mergesAllFields = options?.merge === true;
    this.writeStarted = true;
    this.bufferedWrites.push(() => {
      this.simTx.set(path, data, mergesAllFields ? true : undefined);
    });
    return this;
  }

  update(ref: DocumentReference, dataOrField: DocumentData | string | FieldPath, ...preconditionOrValues: unknown[]): Transaction {
    const path = ref.path;
    const { fields } = parseAdminUpdateArguments(dataOrField, preconditionOrValues);
    const updatePayload = updateFieldsData(fields);
    this.writeStarted = true;
    this.bufferedWrites.push(() => {
      this.simTx.update(path, updatePayload);
    });
    return this;
  }

  delete(ref: DocumentReference): Transaction {
    const path = ref.path;
    this.writeStarted = true;
    this.bufferedWrites.push(() => {
      this.simTx.delete(path);
    });
    return this;
  }

  finalizeBeforeCommit(): void {
    for (const checkLiveConflict of this.queryChecks) {
      const conflictingLivePaths = checkLiveConflict();
      if (conflictingLivePaths !== null) {
        if (this.bypassRules) {
          if (conflictingLivePaths.length > 0) {
            this.simTx.getAll(...conflictingLivePaths);
          }
          return;
        }
        throw new QuerySetConflictError();
      }
    }
    for (const applyWrite of this.bufferedWrites) {
      applyWrite();
    }
  }
}
