/**
 * `Reference#transaction(transactionUpdate, onComplete?, applyLocally?)`
 * implementation for both the local in-process and remote worker-relay arms.
 */

import {
  ref as modularRef,
  runTransaction as modularRunTransaction,
  sandbox as rtdbSandbox,
  type Database as ModularDatabase,
} from 'pyric/database';
import {
  inlinePriorities,
  jsonEqual,
  normalizeNode,
  validateWritablePath,
  validateWrite,
  valueAtChildPath,
} from 'pyric/database/internal';
import type { AdminServiceLifecycle } from '../app/lifecycle.js';
import type { AdminPathCache } from './admin-path-cache.js';
import { buildSandboxSnap, renderSnapshotVal } from './data-snapshot.js';
import { exportedLocalValueAt } from './local-listeners.js';
import { emitAdminDatabaseLog } from './logging.js';
import { hydrateRemoteWireSnapshot, type RemoteWireSnapshot } from './remote-listeners.js';
import {
  assertActivePromise,
  assertValidServerValues,
  joinPath,
  pathSegments,
  preserveNormalizedWithPriorities,
} from './tree-store.js';
import {
  validateCallbackArg,
  type DataSnapshot,
  type JsonValue,
  type Reference,
} from './types.js';

const ADMIN_TRANSACTION_DATA_PREFIX = 'Reference.transaction failed: Data returned ';

export type AdminTransactionUpdate = (currentData: unknown) => unknown;

export type AdminTransactionOnComplete = (
  error: Error | null,
  committed: boolean,
  snapshot: DataSnapshot | null,
) => unknown;

export interface AdminTransactionResult {
  committed: boolean;
  snapshot: DataSnapshot;
}

interface RemoteTransactionCommitReply {
  readonly retry?: boolean;
  readonly committed: boolean;
  readonly snapshot: RemoteWireSnapshot;
}

function validateTransactionProposal(segs: string[], proposal: unknown): JsonValue {
  validateWrite(proposal, joinPath(segs), ADMIN_TRANSACTION_DATA_PREFIX);
  inlinePriorities(proposal);
  assertValidServerValues(proposal);
  return preserveNormalizedWithPriorities(proposal, false);
}

function validateTransactionInvocation(
  canonical: string,
  transactionUpdate: unknown,
  onComplete: unknown,
  applyLocally: unknown,
): void {
  validateWritablePath('Reference.transaction', canonical);
  validateCallbackArg('Reference.transaction', 'transactionUpdate', transactionUpdate, false);
  validateCallbackArg('Reference.transaction', 'onComplete', onComplete, true);
  if (applyLocally !== undefined && typeof applyLocally !== 'boolean') {
    throw new Error('Reference.transaction failed: applyLocally argument must be a boolean.');
  }
}

function invokeTransactionOnComplete(
  promise: Promise<AdminTransactionResult>,
  onComplete?: AdminTransactionOnComplete,
): Promise<AdminTransactionResult> {
  if (onComplete === undefined || onComplete === null) {
    return promise;
  }
  return promise.then(
    (res) => {
      onComplete(null, res.committed, res.snapshot);
      return res;
    },
    (err: unknown) => {
      let errorObj: Error;
      if (err instanceof Error) {
        errorObj = err;
      } else {
        errorObj = new Error(String(err));
      }
      onComplete(errorObj, false, null);
      throw err;
    },
  );
}

function readSilentLocalStored(adminDb: ModularDatabase, segs: readonly string[]): JsonValue {
  const fullTree = rtdbSandbox.snapshotState(adminDb);
  if (segs.length === 0) {
    return fullTree;
  }
  return valueAtChildPath(fullTree, segs) as JsonValue;
}

function renderLocalTransactionInput(
  adminDb: ModularDatabase,
  segs: readonly string[],
): JsonValue {
  const stored = readSilentLocalStored(adminDb, segs);
  if (stored === null) {
    return null;
  }
  return renderSnapshotVal(stored, exportedLocalValueAt(adminDb, segs, stored));
}

export function runLocalAdminTransaction(params: {
  adminDb: ModularDatabase;
  cache: AdminPathCache;
  lifecycle: AdminServiceLifecycle;
  canonical: string;
  segs: string[];
  refAt: (path: string) => Reference;
  transactionUpdate: AdminTransactionUpdate;
  onComplete?: AdminTransactionOnComplete;
  applyLocally?: boolean;
  allowColdWarming?: boolean;
}): Promise<AdminTransactionResult> {
  const {
    adminDb,
    cache,
    lifecycle,
    canonical,
    segs,
    refAt,
    transactionUpdate,
    onComplete,
    applyLocally,
    allowColdWarming = true,
  } = params;
  validateTransactionInvocation(canonical, transactionUpdate, onComplete, applyLocally);
  emitAdminDatabaseLog('transaction', canonical);

  let initialInput: JsonValue = null;
  if (cache.isWarm(canonical) && !lifecycle.isDeleted) {
    initialInput = renderLocalTransactionInput(adminDb, segs);
  }
  const initialRawProposal = transactionUpdate(initialInput);
  let initialValidatedProposal: JsonValue | undefined;
  if (initialRawProposal !== undefined) {
    initialValidatedProposal = validateTransactionProposal(segs, initialRawProposal);
  }

  const execute = async (): Promise<AdminTransactionResult> => {
    lifecycle.assertActive();
    let usedPassZero = false;
    const modTarget = modularRef(adminDb, canonical);
    const modResult = await modularRunTransaction(
      modTarget,
      (current: unknown) => {
        const currentJson = (current ?? null) as JsonValue;
        if (!usedPassZero && jsonEqual(currentJson, initialInput)) {
          usedPassZero = true;
          return initialValidatedProposal;
        }
        usedPassZero = true;
        let orderedCurrent: JsonValue = null;
        if (current !== null && current !== undefined) {
          orderedCurrent = renderLocalTransactionInput(adminDb, segs);
        }
        const nextProposal = transactionUpdate(orderedCurrent);
        if (nextProposal === undefined) {
          return undefined;
        }
        return validateTransactionProposal(segs, nextProposal);
      },
      { applyLocally },
    );

    const finalStored = readSilentLocalStored(adminDb, segs);
    if (allowColdWarming) {
      cache.markWarm(canonical);
    }
    let snapStored: JsonValue = null;
    let snapExported: unknown;
    if (modResult.committed) {
      snapStored = finalStored;
      snapExported = exportedLocalValueAt(adminDb, segs, finalStored);
    } else {
      snapStored = normalizeNode(modResult.snapshot.val());
      snapExported = modResult.snapshot.exportVal();
    }
    const adminSnap = buildSandboxSnap(refAt, canonical, snapStored, snapExported);
    return {
      committed: modResult.committed,
      snapshot: adminSnap,
    };
  };

  return invokeTransactionOnComplete(execute(), onComplete);
}

export function runRemoteAdminTransaction(params: {
  relayOp: (op: { method: `rtdb.${string}`; path: string } & Record<string, unknown>) => Promise<unknown>;
  cache: AdminPathCache;
  lifecycle: AdminServiceLifecycle;
  canonical: string;
  segs: string[];
  refAt: (path: string) => Reference;
  transactionUpdate: AdminTransactionUpdate;
  onComplete?: AdminTransactionOnComplete;
  applyLocally?: boolean;
  allowColdWarming?: boolean;
}): Promise<AdminTransactionResult> {
  const {
    relayOp,
    cache,
    lifecycle,
    canonical,
    segs,
    refAt,
    transactionUpdate,
    onComplete,
    applyLocally,
    allowColdWarming = true,
  } = params;
  const syncRemoteTxCache = (wire: RemoteWireSnapshot): void => {
    if (allowColdWarming || cache.isWarm(canonical)) {
      cache.recordWireSnapshot(canonical, wire);
    } else {
      cache.evictSubtree(canonical);
    }
  };
  validateTransactionInvocation(canonical, transactionUpdate, onComplete, applyLocally);
  emitAdminDatabaseLog('transaction', canonical);

  const startedWarm = cache.isWarm(canonical);
  let initialInput: JsonValue = null;
  if (startedWarm) {
    const cached = cache.readSnapshot(canonical);
    initialInput = renderSnapshotVal(cached.stored, cached.exported);
  }
  const initialRawProposal = transactionUpdate(initialInput);
  let initialValidatedProposal: JsonValue | undefined;
  if (initialRawProposal !== undefined) {
    initialValidatedProposal = validateTransactionProposal(segs, initialRawProposal);
  }

  const execute = async (): Promise<AdminTransactionResult> => {
    const deleted = assertActivePromise(lifecycle);
    if (deleted !== null) {
      await deleted;
    }

    if (initialValidatedProposal === undefined) {
      if (!startedWarm) {
        const emptySnap = buildSandboxSnap(refAt, canonical, null, null);
        return { committed: false, snapshot: emptySnap };
      }
      const currentWire = (await relayOp({
        method: 'rtdb.get',
        path: canonical,
        transaction: true,
      })) as RemoteWireSnapshot;
      syncRemoteTxCache(currentWire);
      return {
        committed: false,
        snapshot: hydrateRemoteWireSnapshot(refAt, canonical, currentWire),
      };
    }

    const firstReply = (await relayOp({
      method: 'rtdb.transactionCommit',
      path: canonical,
      expected: initialInput,
      value: initialValidatedProposal,
      applyLocally,
    })) as RemoteTransactionCommitReply;

    if (firstReply.retry !== true) {
      syncRemoteTxCache(firstReply.snapshot);
      return {
        committed: firstReply.committed,
        snapshot: hydrateRemoteWireSnapshot(refAt, canonical, firstReply.snapshot),
      };
    }

    for (let attempt = 1; attempt < 25; attempt += 1) {
      const beforeWire = (await relayOp({
        method: 'rtdb.get',
        path: canonical,
        transaction: true,
      })) as RemoteWireSnapshot;
      syncRemoteTxCache(beforeWire);
      const beforeStored = normalizeNode(beforeWire.value ?? null);
      const retryInput = renderSnapshotVal(beforeStored, beforeWire.exportValue);
      const retryRawProposal = transactionUpdate(retryInput);
      if (retryRawProposal === undefined) {
        return {
          committed: false,
          snapshot: hydrateRemoteWireSnapshot(refAt, canonical, beforeWire),
        };
      }
      const retryValidatedProposal = validateTransactionProposal(segs, retryRawProposal);
      const commitReply = (await relayOp({
        method: 'rtdb.transactionCommit',
        path: canonical,
        expected: retryInput,
        value: retryValidatedProposal,
        applyLocally,
      })) as RemoteTransactionCommitReply;
      if (commitReply.retry !== true) {
        syncRemoteTxCache(commitReply.snapshot);
        return {
          committed: commitReply.committed,
          snapshot: hydrateRemoteWireSnapshot(refAt, canonical, commitReply.snapshot),
        };
      }
    }

    throw new Error('maxretry');
  };

  return invokeTransactionOnComplete(execute(), onComplete);
}
