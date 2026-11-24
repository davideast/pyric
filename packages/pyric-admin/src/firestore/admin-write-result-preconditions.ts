/**
 * Admin-SDK `WriteResult` construction, per-document `lastUpdateTime` tracking,
 * and runtime `Precondition` (`exists`, `lastUpdateTime`) enforcement across
 * local and JSON-wire remote sandboxes.
 */

import {
  Timestamp as CompatTimestamp,
  type DocumentData,
  type DocumentReference,
} from 'pyric/sandbox/admin-compat';
import { isRemoteSandbox, SandboxError } from 'pyric/sandbox';
import { encodeSnapshotMap, getInternalEnv } from 'pyric/sandbox/internal';
import type { SandboxFirestore } from 'pyric/sandbox/admin-firestore';
import { adminRawDbSandbox } from './admin-handle-registry.js';
import { isObjectRecord } from './admin-write-validation.js';

export interface ParsedAdminPrecondition {
  readonly exists?: boolean;
  readonly lastUpdateTime?: CompatTimestamp;
}

interface RawSnapshotState {
  readonly exists: boolean;
  readonly fingerprint?: string;
}

export type RawSnapshotReader = (docPath: string) => Promise<RawSnapshotState>;

interface AdminWriteLedger {
  lastNanos: bigint;
  readonly docCreateTimes: Map<string, CompatTimestamp>;
  readonly docWriteTimes: Map<string, CompatTimestamp>;
  readonly stateRevisions: Map<string, number>;
  readonly stampedRevisions: Map<string, number>;
  readonly remoteFingerprints: Map<string, string>;
  readonly snapshotReaders: WeakMap<object, RawSnapshotReader>;
}

export interface BatchOperationCheckItem {
  readonly kind: 'create' | 'set' | 'update' | 'delete';
  readonly ref: DocumentReference;
  readonly precondition?: ParsedAdminPrecondition;
}

export interface InitialPreconditionSnapshot {
  readonly exists: boolean;
  readonly updateTime?: CompatTimestamp;
}

const NANOS_PER_MS = 1_000_000n;
const NANOS_PER_SEC = 1_000_000_000n;
const ledgerByIdentity = new WeakMap<object, AdminWriteLedger>();

export class WriteResult {
  readonly writeTime: CompatTimestamp;

  constructor(writeTime: CompatTimestamp) {
    this.writeTime = writeTime;
  }

  isEqual(other: WriteResult): boolean {
    if (this === other) {
      return true;
    }
    if (!(other instanceof WriteResult)) {
      return false;
    }
    return this.writeTime.isEqual(other.writeTime);
  }
}

export function computeDocDataFingerprint(data: DocumentData | undefined): string | undefined {
  if (data === undefined) {
    return undefined;
  }
  return JSON.stringify(encodeSnapshotMap(data));
}

function resolveLedgerKey(rawDb: SandboxFirestore): object {
  const sb = adminRawDbSandbox.get(rawDb);
  if (sb !== undefined && !isRemoteSandbox(sb)) {
    return getInternalEnv(sb);
  }
  if (sb !== undefined) {
    return sb;
  }
  return rawDb;
}

function getLedger(rawDb: SandboxFirestore): AdminWriteLedger {
  const key = resolveLedgerKey(rawDb);
  let ledger = ledgerByIdentity.get(key);
  if (ledger === undefined) {
    const newLedger: AdminWriteLedger = {
      lastNanos: BigInt(Date.now()) * NANOS_PER_MS,
      docCreateTimes: new Map(),
      docWriteTimes: new Map(),
      stateRevisions: new Map(),
      stampedRevisions: new Map(),
      remoteFingerprints: new Map(),
      snapshotReaders: new WeakMap(),
    };
    const sb = adminRawDbSandbox.get(rawDb);
    if (sb !== undefined && !isRemoteSandbox(sb)) {
      const env = getInternalEnv(sb);
      env.onStateChange((changedPath) => {
        if (changedPath === null) {
          newLedger.docCreateTimes.clear();
          newLedger.docWriteTimes.clear();
          newLedger.stateRevisions.clear();
          newLedger.stampedRevisions.clear();
          return;
        }
        const prev = newLedger.stateRevisions.get(changedPath) ?? 0;
        newLedger.stateRevisions.set(changedPath, prev + 1);
      });
    }
    ledgerByIdentity.set(key, newLedger);
    ledger = newLedger;
  }
  return ledger;
}

function syncLocalLedgerForPath(
  rawDb: SandboxFirestore,
  ledger: AdminWriteLedger,
  docPath: string,
): boolean | undefined {
  const sb = adminRawDbSandbox.get(rawDb);
  if (sb === undefined || isRemoteSandbox(sb)) {
    return undefined;
  }
  const env = getInternalEnv(sb);
  const exists = env.getDocument(docPath) !== null;
  if (!exists) {
    ledger.docCreateTimes.delete(docPath);
    ledger.docWriteTimes.delete(docPath);
    ledger.stampedRevisions.delete(docPath);
    return false;
  }
  const currentRev = ledger.stateRevisions.get(docPath) ?? 0;
  const stampedRev = ledger.stampedRevisions.get(docPath);
  if (stampedRev === undefined || stampedRev !== currentRev || !ledger.docWriteTimes.has(docPath)) {
    const updatedAt = nextAdminTimestamp(rawDb);
    if (!ledger.docCreateTimes.has(docPath)) {
      ledger.docCreateTimes.set(docPath, updatedAt);
    }
    ledger.docWriteTimes.set(docPath, updatedAt);
    ledger.stampedRevisions.set(docPath, currentRev);
  }
  return true;
}

export function nextAdminTimestamp(rawDb: SandboxFirestore): CompatTimestamp {
  const ledger = getLedger(rawDb);
  const wallNanos = BigInt(Date.now()) * NANOS_PER_MS;
  let chosen = ledger.lastNanos + 1_000n;
  if (wallNanos > chosen) {
    chosen = wallNanos;
  }
  ledger.lastNanos = chosen;
  const seconds = Number(chosen / NANOS_PER_SEC);
  const nanoseconds = Number(chosen % NANOS_PER_SEC);
  return new CompatTimestamp(seconds, nanoseconds);
}

export function registerBypassSnapshotReader(
  rawDb: SandboxFirestore,
  reader: RawSnapshotReader,
): void {
  const ledger = getLedger(rawDb);
  ledger.snapshotReaders.set(rawDb, reader);
}

export function stampRemoteDocFingerprint(
  rawDb: SandboxFirestore,
  docPath: string,
  fingerprint: string | undefined,
): void {
  if (fingerprint === undefined) {
    return;
  }
  const ledger = getLedger(rawDb);
  ledger.remoteFingerprints.set(docPath, fingerprint);
}

export async function readDocPreconditionState(
  rawDb: SandboxFirestore,
  docPath: string,
): Promise<InitialPreconditionSnapshot> {
  const ledger = getLedger(rawDb);
  const localExists = syncLocalLedgerForPath(rawDb, ledger, docPath);
  if (localExists !== undefined) {
    if (!localExists) {
      return { exists: false };
    }
    return { exists: true, updateTime: ledger.docWriteTimes.get(docPath) };
  }
  const reader = ledger.snapshotReaders.get(rawDb);
  let snapState: RawSnapshotState;
  if (reader !== undefined) {
    snapState = await reader(docPath);
  } else {
    const snap = await rawDb.doc(docPath).get();
    snapState = {
      exists: snap.exists,
      fingerprint: snap.exists ? computeDocDataFingerprint(snap.data()) : undefined,
    };
  }
  if (!snapState.exists) {
    ledger.docCreateTimes.delete(docPath);
    ledger.docWriteTimes.delete(docPath);
    ledger.remoteFingerprints.delete(docPath);
    return { exists: false };
  }
  const resolved = resolveExistingDocTimestamps(rawDb, docPath, snapState.fingerprint);
  return { exists: true, updateTime: resolved.updateTime };
}

export function extractParsedPrecondition(
  rawPrecondition: unknown,
): ParsedAdminPrecondition | undefined {
  if (!isObjectRecord(rawPrecondition)) {
    return undefined;
  }
  const existsVal = rawPrecondition.exists;
  const lastUpdateVal = rawPrecondition.lastUpdateTime;
  const hasExists = typeof existsVal === 'boolean';
  const hasLastUpdate = lastUpdateVal instanceof CompatTimestamp;
  if (!hasExists && !hasLastUpdate) {
    return undefined;
  }
  if (hasExists) {
    return { exists: existsVal };
  }
  return { lastUpdateTime: lastUpdateVal as CompatTimestamp };
}

export function extractUpdateTrailingPrecondition(
  rawArgs: readonly unknown[],
): ParsedAdminPrecondition | undefined {
  if (rawArgs.length === 0) {
    return undefined;
  }
  const first = rawArgs[0];
  if (typeof first === 'string' || (typeof first === 'object' && first !== null && '_internalPath' in first)) {
    if (rawArgs.length >= 3 && rawArgs.length % 2 === 1) {
      return extractParsedPrecondition(rawArgs[rawArgs.length - 1]);
    }
    return undefined;
  }
  if (rawArgs.length === 2) {
    return extractParsedPrecondition(rawArgs[1]);
  }
  return undefined;
}

function verifyPreconditionState(
  docPath: string,
  method: 'update' | 'delete',
  precondition: ParsedAdminPrecondition,
  exists: boolean,
  recordedUpdateTime: CompatTimestamp | undefined,
  mutatedEarlierInSequence = false,
): void {
  if (precondition.lastUpdateTime !== undefined) {
    if (
      mutatedEarlierInSequence ||
      !exists ||
      recordedUpdateTime === undefined ||
      !recordedUpdateTime.isEqual(precondition.lastUpdateTime)
    ) {
      throw new SandboxError(
        'failed-precondition',
        `Precondition failed for document "${docPath}".`,
      );
    }
    return;
  }
  if (precondition.exists === true && !exists) {
    throw new SandboxError('not-found', `No document to ${method}: ${docPath}`);
  }
  if (precondition.exists === false && exists) {
    throw new SandboxError('already-exists', `Document already exists: ${docPath}`);
  }
}

export async function assertSingleWritePrecondition(
  rawDb: SandboxFirestore,
  docPath: string,
  method: 'update' | 'delete',
  precondition: ParsedAdminPrecondition | undefined,
): Promise<void> {
  if (precondition === undefined) {
    return;
  }
  if (method === 'update' && precondition.exists === true && precondition.lastUpdateTime === undefined) {
    return;
  }
  const state = await readDocPreconditionState(rawDb, docPath);
  verifyPreconditionState(docPath, method, precondition, state.exists, state.updateTime);
}

export async function assertBatchPreconditions(
  rawDb: SandboxFirestore,
  ops: ReadonlyArray<BatchOperationCheckItem>,
  pinnedInitialStates?: ReadonlyMap<string, InitialPreconditionSnapshot>,
): Promise<void> {
  const simulated = new Map<
    string,
    { exists: boolean; updateTime: CompatTimestamp | undefined; mutated: boolean }
  >();
  for (const op of ops) {
    const docPath = op.ref.path;
    const prior = simulated.get(docPath);
    let exists: boolean;
    let updateTime: CompatTimestamp | undefined;
    let mutatedEarlier = false;
    if (prior !== undefined) {
      exists = prior.exists;
      updateTime = prior.updateTime;
      mutatedEarlier = prior.mutated;
    } else {
      const pinned = pinnedInitialStates?.get(docPath);
      if (pinned !== undefined) {
        exists = pinned.exists;
        updateTime = pinned.updateTime;
      } else {
        const current = await readDocPreconditionState(rawDb, docPath);
        exists = current.exists;
        updateTime = current.updateTime;
      }
    }

    if ((op.kind === 'update' || op.kind === 'delete') && op.precondition !== undefined) {
      verifyPreconditionState(
        docPath,
        op.kind,
        op.precondition,
        exists,
        updateTime,
        mutatedEarlier,
      );
    }

    if (op.kind === 'delete') {
      simulated.set(docPath, { exists: false, updateTime: undefined, mutated: true });
    } else {
      simulated.set(docPath, { exists: true, updateTime: undefined, mutated: true });
    }
  }
}

export function recordSeededAdminDocuments(
  rawDb: SandboxFirestore,
  docPaths: readonly string[],
): CompatTimestamp {
  const ledger = getLedger(rawDb);
  ledger.docCreateTimes.clear();
  ledger.docWriteTimes.clear();
  ledger.stampedRevisions.clear();
  ledger.remoteFingerprints.clear();
  const seedTime = nextAdminTimestamp(rawDb);
  for (const path of docPaths) {
    ledger.docCreateTimes.set(path, seedTime);
    ledger.docWriteTimes.set(path, seedTime);
    ledger.stampedRevisions.set(path, ledger.stateRevisions.get(path) ?? 0);
  }
  return seedTime;
}

export function resolveExistingDocTimestamps(
  rawDb: SandboxFirestore,
  docPath: string,
  remoteFingerprint?: string,
): { readonly createTime: CompatTimestamp; readonly updateTime: CompatTimestamp } {
  const ledger = getLedger(rawDb);
  syncLocalLedgerForPath(rawDb, ledger, docPath);
  if (remoteFingerprint !== undefined) {
    const prevFp = ledger.remoteFingerprints.get(docPath);
    if (prevFp !== undefined && prevFp !== remoteFingerprint) {
      const bumped = nextAdminTimestamp(rawDb);
      if (!ledger.docCreateTimes.has(docPath)) {
        ledger.docCreateTimes.set(docPath, bumped);
      }
      ledger.docWriteTimes.set(docPath, bumped);
    }
    ledger.remoteFingerprints.set(docPath, remoteFingerprint);
  }
  let updateTime = ledger.docWriteTimes.get(docPath);
  if (updateTime === undefined) {
    updateTime = nextAdminTimestamp(rawDb);
    ledger.docCreateTimes.set(docPath, updateTime);
    ledger.docWriteTimes.set(docPath, updateTime);
    ledger.stampedRevisions.set(docPath, ledger.stateRevisions.get(docPath) ?? 0);
    return { createTime: updateTime, updateTime };
  }
  let createTime = ledger.docCreateTimes.get(docPath);
  if (createTime === undefined) {
    createTime = updateTime;
    ledger.docCreateTimes.set(docPath, createTime);
  }
  return { createTime, updateTime };
}

export function recordSingleAdminWrite(rawDb: SandboxFirestore, docPath: string): WriteResult {
  const writeTime = nextAdminTimestamp(rawDb);
  const ledger = getLedger(rawDb);
  if (!ledger.docCreateTimes.has(docPath)) {
    ledger.docCreateTimes.set(docPath, writeTime);
  }
  ledger.docWriteTimes.set(docPath, writeTime);
  ledger.stampedRevisions.set(docPath, ledger.stateRevisions.get(docPath) ?? 0);
  return new WriteResult(writeTime);
}

export function recordSingleAdminDelete(rawDb: SandboxFirestore, docPath: string): WriteResult {
  const writeTime = nextAdminTimestamp(rawDb);
  const ledger = getLedger(rawDb);
  ledger.docCreateTimes.delete(docPath);
  ledger.docWriteTimes.delete(docPath);
  ledger.stampedRevisions.delete(docPath);
  ledger.remoteFingerprints.delete(docPath);
  return new WriteResult(writeTime);
}

export function recordBatchAdminMutations(
  rawDb: SandboxFirestore,
  ops: ReadonlyArray<{ readonly path: string; readonly kind: 'write' | 'delete' }>,
): WriteResult[] {
  if (ops.length === 0) {
    return [];
  }
  const commitTime = nextAdminTimestamp(rawDb);
  const ledger = getLedger(rawDb);
  const results: WriteResult[] = [];
  for (const op of ops) {
    if (op.kind === 'delete') {
      ledger.docCreateTimes.delete(op.path);
      ledger.docWriteTimes.delete(op.path);
      ledger.stampedRevisions.delete(op.path);
      ledger.remoteFingerprints.delete(op.path);
    } else {
      if (!ledger.docCreateTimes.has(op.path)) {
        ledger.docCreateTimes.set(op.path, commitTime);
      }
      ledger.docWriteTimes.set(op.path, commitTime);
      ledger.stampedRevisions.set(op.path, ledger.stateRevisions.get(op.path) ?? 0);
    }
    results.push(new WriteResult(commitTime));
  }
  return results;
}

export function recordTransactionAdminMutations(
  rawDb: SandboxFirestore,
  ops: ReadonlyArray<{ readonly path: string; readonly kind: 'write' | 'delete' }>,
): CompatTimestamp | undefined {
  if (ops.length === 0) {
    return undefined;
  }
  const results = recordBatchAdminMutations(rawDb, ops);
  return results[0]?.writeTime;
}
