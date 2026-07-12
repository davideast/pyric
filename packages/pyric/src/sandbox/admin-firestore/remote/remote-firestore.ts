/**
 * Remote arm of the admin-shaped Firestore surface (remote sandbox,
 * slice 2 / checkpoint 2).
 *
 * A PARALLEL channel-backed implementation of `pyric/sandbox/admin-compat`'s
 * type surface (`Firestore` / `DocumentReference` / `Query` / `WriteBatch` /
 * `Transaction`), per the remote-Firestore spike verdict: the local
 * admin-compat layer is welded to `LocalEnvironment`'s SYNCHRONOUS engine
 * seam and cannot run over a WebSocket, so the remote arm re-implements the
 * SHAPE over `RemoteSandboxChannel.op`/`subscribe` worker-relay frames —
 * exactly the fork `pyric-admin/database` took for RTDB. The two arms share
 * the type surface and the conformance assertions, not the implementation.
 *
 * This module is the facade — `createRemoteFirestore` wires the collaborator
 * files in this directory (`channel.ts` for the op dispatcher, `doc-ref.ts` /
 * `query.ts` for refs, `batch.ts` for `WriteBatch`, `transaction.ts` for
 * `Transaction`, `value-codec.ts` / `errors.ts` / `wire-types.ts` for the
 * shared wire plumbing, `listeners.ts` for `onSnapshot`, `snapshots.ts` for
 * one-shot reads) into the `SandboxFirestore` surface `../get-firestore.ts`
 * and `../get-admin-firestore.ts` dispatch to for a remote sandbox context.
 *
 * DEPENDENCY DIRECTION: this module lives in `pyric` and may only consume
 * the STRUCTURAL channel contract from `pyric/sandbox`'s remote seam
 * (`RemoteSandboxChannel` — one loose `op`, one loose `subscribe`). The
 * concrete worker-protocol unions live in `pyric-tools`, which `pyric`
 * cannot import; ops are spelled loosely (`{ method: 'getDoc', path,
 * actAs }`) and kept structurally identical to
 * `pyric-tools/src/serve/worker/protocol.ts`.
 *
 * IDENTITY: every op and every subscription pins an EXPLICIT `actAs` lens.
 * An ABSENT lens resolves worker-side to the browser tab's PORT SESSION —
 * whoever happens to be signed in in the tab — which is never what a
 * server-side handle means. `getAdminFirestore` pins `{ mode: 'admin' }`
 * (rules bypass); `getFirestore(ctx)` pins `{ mode: 'as', uid, token? }`
 * for a signed identity or `{ mode: 'anon' }` for `withAuth(null)`. The
 * `as` lens carries the FULL `AuthState` (uid + custom-claims token): the
 * worker host resolves it via `sandbox.withAuth({ uid, token })`, so there
 * is no identity-fidelity loss versus the local arm.
 *
 * See `value-codec.ts` for the write/read value codec (including the
 * accepted marker-lookalike divergence), `query.ts` for the cursor
 * fidelity limits, and `transaction.ts` for the optimistic-transaction
 * protocol.
 */

import { SandboxError, type AuthLens, type RemoteSandbox } from 'pyric/sandbox';
import type {
  CollectionReference,
  DocumentReference,
  OperationOptions,
  Query,
  Transaction,
  WriteBatch,
} from 'pyric/sandbox/admin-compat';
import {
  isCollectionPath,
  isDocumentPath,
} from '../../firestore/admin-compat/paths.js';
import type { SandboxFirestore } from '../index.js';
import { type RemoteArm } from './channel.js';
import { invalidArgument } from './errors.js';
import { makeCollectionRef, makeDocRef } from './doc-ref.js';
import { makeQuery } from './query.js';
import { makeWriteBatch } from './batch.js';
import { runRemoteTransaction } from './transaction.js';

/** Canonical remediating throw for sync-only sandbox members that cannot
 *  span the wire. Mirrors the slice-1 handle's error style. */
function syncOnlyRemotely(member: string, remedy: string): SandboxError {
  return new SandboxError(
    'unimplemented',
    `SandboxFirestore.${member} is not available on a remote sandbox — its return ` +
      `value is synchronous and the data lives in the browser worker. ${remedy}`,
  );
}

/**
 * Build the channel-backed `SandboxFirestore` for a remote sandbox handle.
 * `lens` is pinned on EVERY op and subscription (see the module header for
 * the identity mapping); path-shape validation matches the local arm so
 * `invalid-argument` failures surface at the call site without a
 * round-trip.
 */
export function createRemoteFirestore(
  sandbox: RemoteSandbox,
  lens: AuthLens,
): SandboxFirestore {
  const arm: RemoteArm = { sandbox, lens };

  return {
    // ── Production-shaped surface ────────────────────────────────────
    collection(path: string): CollectionReference {
      if (!isCollectionPath(path)) {
        throw invalidArgument(`collection path must have an odd number of segments: ${path}`);
      }
      return makeCollectionRef(arm, path);
    },
    doc(path: string): DocumentReference {
      if (!isDocumentPath(path)) {
        throw invalidArgument(`document path must have an even number of segments: ${path}`);
      }
      return makeDocRef(arm, path);
    },
    collectionGroup(collectionId: string): Query {
      if (collectionId.length === 0 || collectionId.includes('/')) {
        throw invalidArgument(
          `collection group id must be a single non-empty segment with no '/': ${collectionId}`,
        );
      }
      return makeQuery(arm, {
        source: { __ref: 'group', collectionId },
        filters: [],
        orders: [],
        limitFromEnd: false,
      });
    },
    batch(): WriteBatch {
      return makeWriteBatch(arm);
    },
    runTransaction<R>(
      fn: (tx: Transaction) => Promise<R> | R,
      _opts?: OperationOptions,
    ): Promise<R> {
      return runRemoteTransaction(arm, fn);
    },

    // ── Sandbox-only surface (sync contracts — remediating throws) ───
    setRules(): never {
      throw syncOnlyRemotely(
        'setRules',
        "Deploy rules asynchronously through the relay instead: `await sandbox.channel.op({ method: 'setFirestoreRules', source })`.",
      );
    },
    seed(): never {
      throw syncOnlyRemotely(
        'seed',
        'The relay has no atomic seed op; write seed docs through this handle ' +
          "(`db.doc(path).set(data)` / `db.batch()`), or drive `sandbox.channel.op({ method: 'admin.setDocument', path, data })` per document.",
      );
    },
    snapshot(): never {
      throw syncOnlyRemotely(
        'snapshot',
        "Read the worker state asynchronously instead: `await sandbox.channel.op({ method: 'admin.readState' })`.",
      );
    },
  };
}
