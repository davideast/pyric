/**
 * Admin-SDK `WriteResult` construction, per-document `lastUpdateTime` tracking,
 * and runtime `Precondition` (`exists`, `lastUpdateTime`) enforcement across
 * local and JSON-wire remote sandboxes.
 */

import {
  Timestamp as CompatTimestamp,
  type DocumentReference,
} from 'pyric/sandbox/admin-compat';
import { isRemoteSandbox, SandboxError } from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';
import type { SandboxFirestore } from 'pyric/sandbox/admin-firestore';
import { adminRawDbSandbox } from './admin-handle-registry.js';
import { isObjectRecord } from './admin-write-validation.js';

export interface ParsedAdminPrecondition {
  readonly exists?: boolean;
  readonly lastUpdateTime?: CompatTimestamp;
}

export type RawExistenceReader = (docPath: string) => Promise<boolean>;

interface AdminWriteLedger {
  lastNanos: bigint;
  readonly docCreateTimes: Map<string, CompatTimestamp>;
  readonly docWriteTimes: Map<string, CompatTimestamp>;
  readonly existenceReaders: WeakMap<object, RawExistenceReader>;
}

export interface BatchOperationCheckItem {
  readonly kind: 'create' | 'set' | 'update' | 'delete';
  readonly ref: DocumentReference;
  readonly precondition?: ParsedAdminPrecondition;
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
    if (typeof other !== 'object' || other === null) {
      return false;
    }
    const candidateTime = (other as { writeTime?: unknown }).writeTime;
    if (!(candidateTime instanceof CompatTimestamp)) {
      return false;
    }
    return this.writeTime.isEqual(candidateTime);
  }
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
    ledger = {
      lastNanos: BigInt(Date.now()) * NANOS_PER_MS,
      docCreateTimes: new Map(),
      docWriteTimes: new Map(),
      existenceReaders: new WeakMap(),
    };
    ledgerByIdentity.set(key, ledger);
  }
  return ledger;
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

export function registerBypassExistenceReader(
  rawDb: SandboxFirestore,
  reader: RawExistenceReader,
): void {
  const ledger = getLedger(rawDb);
  ledger.existenceReaders.set(rawDb, reader);
}

async function readDocumentExists(rawDb: SandboxFirestore, docPath: string): Promise<boolean> {
  const ledger = getLedger(rawDb);
  const reader = ledger.existenceReaders.get(rawDb);
  if (reader !== undefined) {
    return reader(docPath);
  }
  const sb = adminRawDbSandbox.get(rawDb);
  if (sb !== undefined && !isRemoteSandbox(sb)) {
    return getInternalEnv(sb).getDocument(docPath) !== null;
  }
  const snap = await rawDb.doc(docPath).get();
  return snap.exists;
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

export function verifyPreconditionState(
  rawDb: SandboxFirestore,
  docPath: string,
  method: 'update' | 'delete',
  precondition: ParsedAdminPrecondition,
  exists: boolean,
  mutatedEarlierInBatch = false,
): void {
  if (precondition.lastUpdateTime !== undefined) {
    if (mutatedEarlierInBatch) {
      throw new SandboxError(
        'failed-precondition',
        `Precondition failed for document "${docPath}".`,
      );
    }
    const recorded = getLedger(rawDb).docWriteTimes.get(docPath);
    if (!exists || recorded === undefined || !recorded.isEqual(precondition.lastUpdateTime)) {
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
  const exists = await readDocumentExists(rawDb, docPath);
  verifyPreconditionState(rawDb, docPath, method, precondition, exists);
}

export async function assertBatchPreconditions(
  rawDb: SandboxFirestore,
  ops: ReadonlyArray<BatchOperationCheckItem>,
): Promise<void> {
  const simulated = new Map<string, { exists: boolean; mutated: boolean }>();
  for (const op of ops) {
    const docPath = op.ref.path;
    const prior = simulated.get(docPath);
    let exists: boolean;
    let mutatedEarlier = false;
    if (prior !== undefined) {
      exists = prior.exists;
      mutatedEarlier = prior.mutated;
    } else {
      exists = await readDocumentExists(rawDb, docPath);
    }

    if ((op.kind === 'update' || op.kind === 'delete') && op.precondition !== undefined) {
      verifyPreconditionState(
        rawDb,
        docPath,
        op.kind,
        op.precondition,
        exists,
        mutatedEarlier,
      );
    }

    if (op.kind === 'delete') {
      simulated.set(docPath, { exists: false, mutated: true });
    } else {
      simulated.set(docPath, { exists: true, mutated: true });
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
  const seedTime = nextAdminTimestamp(rawDb);
  for (const path of docPaths) {
    ledger.docCreateTimes.set(path, seedTime);
    ledger.docWriteTimes.set(path, seedTime);
  }
  return seedTime;
}

export function resolveExistingDocTimestamps(
  rawDb: SandboxFirestore,
  docPath: string,
): { readonly createTime: CompatTimestamp; readonly updateTime: CompatTimestamp } {
  const ledger = getLedger(rawDb);
  let updateTime = ledger.docWriteTimes.get(docPath);
  if (updateTime === undefined) {
    updateTime = nextAdminTimestamp(rawDb);
    ledger.docCreateTimes.set(docPath, updateTime);
    ledger.docWriteTimes.set(docPath, updateTime);
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
  return new WriteResult(writeTime);
}

export function recordSingleAdminDelete(rawDb: SandboxFirestore, docPath: string): WriteResult {
  const writeTime = nextAdminTimestamp(rawDb);
  const ledger = getLedger(rawDb);
  ledger.docCreateTimes.delete(docPath);
  ledger.docWriteTimes.delete(docPath);
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
    } else {
      if (!ledger.docCreateTimes.has(op.path)) {
        ledger.docCreateTimes.set(op.path, commitTime);
      }
      ledger.docWriteTimes.set(op.path, commitTime);
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
