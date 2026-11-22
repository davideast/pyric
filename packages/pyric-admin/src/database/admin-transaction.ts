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
  coerceArrays,
  inlinePriorities,
  jsonEqual,
  normalizeNode,
  validateWritablePath,
  validateWrite,
  valueAtChildPath,
} from 'pyric/database/internal';
import type { AdminServiceLifecycle } from '../app/lifecycle.js';
import { buildSandboxSnap } from './data-snapshot.js';
import { exportedLocalValueAt } from './local-listeners.js';
import { emitAdminDatabaseLog } from './logging.js';
import { hydrateRemoteWireSnapshot, type RemoteWireSnapshot } from './remote-listeners.js';
import { assertActivePromise, joinPath, pathSegments } from './tree-store.js';
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

/**
 * Per-handle path warmth and value mirror so synchronous pass-0 `transaction`
 * execution matches `@firebase/database-compat` (`repoStartTransaction`).
 */
export class AdminPathCache {
  private readonly warmCoverage = new Set<string>();
  private rootTree: JsonValue = null;

  isWarm(canonical: string): boolean {
    if (this.warmCoverage.has('/') || this.warmCoverage.has(canonical)) {
      return true;
    }
    const segs = pathSegments(canonical);
    for (let i = 1; i < segs.length; i += 1) {
      const ancestor = joinPath(segs.slice(0, i));
      if (this.warmCoverage.has(ancestor)) {
        return true;
      }
    }
    return false;
  }

  read(canonical: string): JsonValue {
    const segs = pathSegments(canonical);
    let cursor: JsonValue = this.rootTree;
    for (const seg of segs) {
      if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) {
        return null;
      }
      const record = cursor as Record<string, JsonValue>;
      if (!Object.hasOwn(record, seg)) {
        return null;
      }
      const next = record[seg];
      if (next === undefined) {
        return null;
      }
      cursor = next;
    }
    return cursor;
  }

  markWarm(canonical: string): void {
    this.warmCoverage.add(canonical);
  }

  recordValue(canonical: string, stored: JsonValue): void {
    this.warmCoverage.add(canonical);
    const segs = pathSegments(canonical);
    const cloned = structuredClone(stored);
    if (segs.length === 0) {
      this.rootTree = cloned;
      return;
    }
    this.rootTree = writeAtSegments(this.rootTree, segs, 0, cloned);
  }

  recordPatch(canonical: string, patch: Record<string, JsonValue>): void {
    const baseSegs = pathSegments(canonical);
    for (const [relKey, val] of Object.entries(patch)) {
      const relSegs = pathSegments(relKey);
      const lastSeg = relSegs[relSegs.length - 1];
      if (lastSeg === '.priority') {
        continue;
      }
      const targetPath = joinPath([...baseSegs, ...relSegs]);
      this.recordValue(targetPath, normalizeNode(val));
    }
  }

  reset(): void {
    this.warmCoverage.clear();
    this.rootTree = null;
  }
}

function writeAtSegments(
  node: JsonValue,
  segs: readonly string[],
  index: number,
  leaf: JsonValue,
): JsonValue {
  if (index >= segs.length) {
    return leaf;
  }
  const key = segs[index];
  if (key === undefined) {
    return leaf;
  }
  const isObjectNode = node !== null && typeof node === 'object' && !Array.isArray(node);
  if (!isObjectNode && node !== null && leaf === null) {
    // Removing or setting null below a primitive leaf leaves the leaf intact (#1935).
    return node;
  }
  let baseRecord: Record<string, JsonValue> = {};
  if (isObjectNode) {
    baseRecord = { ...(node as Record<string, JsonValue>) };
  }
  let existingChild: JsonValue = null;
  if (Object.hasOwn(baseRecord, key)) {
    const ownVal = baseRecord[key];
    if (ownVal !== undefined) {
      existingChild = ownVal;
    }
  }
  const updatedChild = writeAtSegments(existingChild, segs, index + 1, leaf);
  if (updatedChild === null) {
    delete baseRecord[key];
  } else {
    baseRecord[key] = updatedChild;
  }
  if (Object.keys(baseRecord).length === 0) {
    return null;
  }
  return baseRecord;
}

function validateTransactionProposal(segs: string[], proposal: unknown): JsonValue {
  validateWrite(proposal, joinPath(segs), ADMIN_TRANSACTION_DATA_PREFIX);
  inlinePriorities(proposal);
  return structuredClone(proposal) as JsonValue;
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

function cloneCoercedInput(stored: JsonValue): JsonValue {
  if (stored === null) {
    return null;
  }
  return coerceArrays(structuredClone(stored));
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
  } = params;
  validateTransactionInvocation(canonical, transactionUpdate, onComplete, applyLocally);
  emitAdminDatabaseLog('transaction', canonical);

  let initialStored: JsonValue = null;
  if (cache.isWarm(canonical) && !lifecycle.isDeleted) {
    initialStored = readSilentLocalStored(adminDb, segs);
  }
  const initialInput = cloneCoercedInput(initialStored);
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
        const nextProposal = transactionUpdate(current);
        if (nextProposal === undefined) {
          return undefined;
        }
        return validateTransactionProposal(segs, nextProposal);
      },
      { applyLocally },
    );

    const finalStored = readSilentLocalStored(adminDb, segs);
    cache.markWarm(canonical);
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
  } = params;
  validateTransactionInvocation(canonical, transactionUpdate, onComplete, applyLocally);
  emitAdminDatabaseLog('transaction', canonical);

  const startedWarm = cache.isWarm(canonical);
  let initialStored: JsonValue = null;
  if (startedWarm) {
    initialStored = cache.read(canonical);
  }
  const initialInput = cloneCoercedInput(initialStored);
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
      cache.recordValue(canonical, normalizeNode(currentWire.value ?? null));
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
      cache.recordValue(canonical, normalizeNode(firstReply.snapshot.value ?? null));
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
      const beforeStored = normalizeNode(beforeWire.value ?? null);
      cache.recordValue(canonical, beforeStored);
      const retryInput = cloneCoercedInput(beforeStored);
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
        cache.recordValue(canonical, normalizeNode(commitReply.snapshot.value ?? null));
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
