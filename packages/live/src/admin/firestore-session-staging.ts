/**
 * Bounded delta collection and staged `WriteBatch` / `Transaction` session
 * capture for `@google-cloud/firestore`.
 *
 * `WriteBatch` operations stage into a per-batch collector and emit only when
 * `WriteBatch.commit` resolves `ok`. `Transaction` operations stage into an
 * attempt-scoped collector recreated on every `runTransactionOnce` retry so
 * failed or rolled-back attempts never leak into session memory.
 */
import { isObject } from '../database.js';
import { changedDocuments, DeltaOps } from '../firestore-session-capture.js';
import { isValidDocPath, normalizeDocPath, type SessionCopyResult } from '../firestore-session-values.js';
import { isPlainObject } from '../json-copy.js';
import type { SessionBudget } from '../session-budget.js';
import type { ObservedFirestoreSessionOp, ObservedSessionDelta } from '../session-data.js';
import {
  adminCreateDocOp,
  adminDocFields,
  adminSetDocOp,
  adminUpdateDocOp,
} from './firestore-session-values.js';
import { keepShape } from './patch.js';

const BATCH_PATCHED = Symbol.for('pyric.live.admin.firestore.batchSessionPatched');
const TX_PATCHED = Symbol.for('pyric.live.admin.firestore.txSessionPatched');

type AnyMethod = (this: unknown, ...args: unknown[]) => unknown;
type WriteMethodName = 'create' | 'set' | 'update' | 'delete';

export interface AdminGetAllCall {
  readonly kind: 'admin-get-all';
  readonly hasFieldMask: boolean;
  readonly docRefs: readonly unknown[];
}

export interface AdminTransactionSession {
  readonly kind: 'admin-tx-session';
  currentAttempt: DeltaOps | undefined;
}

const defaultConverters = new WeakMap<object, unknown>();
const batchCollectors = new WeakMap<object, DeltaOps>();
const txOwnedBatches = new WeakSet<object>();
const txSessionsByCallback = new WeakMap<Function, AdminTransactionSession>();
const txAttempts = new WeakMap<object, DeltaOps>();

function ownerFirestoreOf(target: unknown): object | undefined {
  if (!isObject(target)) return undefined;
  const direct: unknown = target._firestore;
  if (isObject(direct)) return direct;
  const ref: unknown = target.ref;
  if (isObject(ref) && isObject(ref._firestore)) return ref._firestore;
  const query: unknown = target.query;
  if (isObject(query) && isObject(query._firestore)) return query._firestore;
  return undefined;
}

function defaultConverterOf(firestore: object | undefined): unknown {
  if (firestore === undefined) return undefined;
  if (defaultConverters.has(firestore)) return defaultConverters.get(firestore);
  const docFn: unknown = Reflect.get(firestore, 'doc');
  if (typeof docFn !== 'function') return undefined;
  try {
    const probe: unknown = Reflect.apply(docFn, firestore, ['__pyric_probe__/doc']);
    if (!isObject(probe)) return undefined;
    const converter = probe._converter;
    defaultConverters.set(firestore, converter);
    return converter;
  } catch {
    return undefined;
  }
}

function rawConverterOf(target: unknown): unknown {
  if (!isObject(target)) return undefined;
  if (target._converter !== undefined) return target._converter;
  if (isObject(target._queryOptions) && target._queryOptions.converter !== undefined) {
    return target._queryOptions.converter;
  }
  if (isObject(target.ref) && target.ref._converter !== undefined) return target.ref._converter;
  if (isObject(target.query)) {
    if (target.query._converter !== undefined) return target.query._converter;
    if (isObject(target.query._queryOptions)) return target.query._queryOptions.converter;
  }
  return undefined;
}

/** Whether an Admin ref, query, or snapshot carries a non-default user converter. */
export function hasAdminCustomConverter(target: unknown): boolean {
  const converter = rawConverterOf(target);
  if (converter === undefined || converter === null) return false;
  const defaultConverter = defaultConverterOf(ownerFirestoreOf(target));
  return converter !== defaultConverter;
}

function rawProjectionOf(target: unknown): unknown {
  if (!isObject(target)) return undefined;
  if (isObject(target._queryOptions)) return target._queryOptions.projection;
  if (isObject(target.query) && isObject(target.query._queryOptions)) {
    return target.query._queryOptions.projection;
  }
  return undefined;
}

/** Whether an Admin query or query snapshot applies a `select(...)` field projection. */
export function hasAdminQueryProjection(target: unknown): boolean {
  const projection = rawProjectionOf(target);
  return projection !== undefined && projection !== null;
}

export function docPathOfAdminRef(ref: unknown): string | undefined {
  if (!isObject(ref)) return undefined;
  const rawPath = ref.path;
  if (!isValidDocPath(rawPath as string | undefined)) return undefined;
  return normalizeDocPath(rawPath as string);
}

export function docSnapPathOf(snap: object, fallbackPath?: string): string | undefined {
  const fromRef = docPathOfAdminRef(Reflect.get(snap, 'ref'));
  if (fromRef !== undefined) return fromRef;
  if (isValidDocPath(fallbackPath)) return normalizeDocPath(fallbackPath);
  return undefined;
}

export function adminSnapshotExists(snap: object): boolean {
  const existsProp: unknown = Reflect.get(snap, 'exists');
  if (typeof existsProp === 'boolean') return existsProp;
  if (typeof existsProp === 'function') return Reflect.apply(existsProp, snap, []) === true;
  return true;
}

export function isAdminDocumentSnapshot(value: unknown): value is object {
  if (!isObject(value)) return false;
  if (typeof value.data !== 'function') return false;
  return typeof value.exists === 'boolean' || typeof value.exists === 'function';
}

export function parseAdminGetAllCall(args: readonly unknown[]): AdminGetAllCall {
  if (args.length === 0) return { kind: 'admin-get-all', hasFieldMask: false, docRefs: [] };
  const last = args[args.length - 1];
  if (isPlainObject(last)) {
    const hasFieldMask = Reflect.get(last, 'fieldMask') !== undefined;
    return { kind: 'admin-get-all', hasFieldMask, docRefs: args.slice(0, -1) };
  }
  return { kind: 'admin-get-all', hasFieldMask: false, docRefs: [...args] };
}

function isUnsupportedAdminDocSnapshot(docSnap: unknown, sourceRef?: unknown): boolean {
  return !isObject(docSnap) || hasAdminCustomConverter(sourceRef) || hasAdminCustomConverter(docSnap);
}

/** Appends a slice of document snapshots to `collector`, counting remaining entries if cut off. */
export function addAdminSnapshotBatch(
  collector: DeltaOps,
  snapshots: readonly unknown[],
  refs?: readonly unknown[],
): void {
  for (let i = 0; i < snapshots.length; i++) {
    if (collector.refusesMore()) continue;
    const ref = refs?.[i];
    addAdminDocSnapshot(collector, snapshots[i], docPathOfAdminRef(ref), ref);
  }
}

function addAdminDocSnapshot(
  collector: DeltaOps,
  docSnap: unknown,
  fallbackPath?: string,
  sourceRef?: unknown,
): boolean {
  if (isUnsupportedAdminDocSnapshot(docSnap, sourceRef)) {
    collector.skip('unsupported');
    return true;
  }
  const snapObj = docSnap as object;
  const path = docSnapPathOf(snapObj, fallbackPath);
  if (path === undefined) {
    collector.skip('unsupported');
    return true;
  }
  if (!adminSnapshotExists(snapObj)) {
    return collector.add(() => ({ ok: true, value: { kind: 'delete', path } }));
  }
  const dataFn: unknown = Reflect.get(snapObj, 'data');
  if (typeof dataFn !== 'function') {
    collector.skip('unsupported');
    return true;
  }
  return collector.add((budget) => {
    const fields = adminDocFields(Reflect.apply(dataFn, snapObj, []), budget);
    if (!fields.ok) return fields;
    return { ok: true, value: { kind: 'set', path, data: fields.value } };
  });
}

export function addAdminQuerySnapshot(
  collector: DeltaOps,
  snap: object,
  useChanges: boolean,
): void {
  if (hasAdminCustomConverter(snap) || hasAdminQueryProjection(snap)) {
    collector.skip('unsupported');
    return;
  }
  let documents: unknown;
  if (useChanges) documents = changedDocuments(snap);
  if (documents === undefined) documents = Reflect.get(snap, 'docs');
  if (!Array.isArray(documents)) return;
  addAdminSnapshotBatch(collector, documents);
}

function stagedWriteOp(
  method: WriteMethodName,
  args: readonly unknown[],
  budget: SessionBudget,
): SessionCopyResult<ObservedFirestoreSessionOp> {
  try {
    const ref = args[0];
    if (hasAdminCustomConverter(ref)) return { ok: false, reason: 'unsupported' };
    const path = docPathOfAdminRef(ref);
    if (path === undefined) return { ok: false, reason: 'unsupported' };
    if (method === 'delete') return { ok: true, value: { kind: 'delete', path } };
    if (method === 'create') return adminCreateDocOp(path, args[1], budget);
    if (method === 'set') return adminSetDocOp(path, args[1], args[2], budget);
    return adminUpdateDocOp(path, args.slice(1), budget);
  } catch {
    return { ok: false, reason: 'unsupported' };
  }
}

function recordStagedWrite(collector: DeltaOps, method: WriteMethodName, args: readonly unknown[]): void {
  if (collector.refusesMore()) return;
  collector.add((budget) => stagedWriteOp(method, args, budget));
}

function patchMethod(prototype: object, name: string, wrap: (real: AnyMethod) => AnyMethod): void {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
  const real = descriptor?.value as unknown;
  if (typeof real !== 'function') return;
  Object.defineProperty(prototype, name, {
    ...descriptor,
    value: keepShape(wrap(real as AnyMethod), real as AnyMethod),
  });
}

/** Reads the staged delta for a `WriteBatch` when `commit()` begins. */
export function commitAdminBatchDelta(batch: unknown): ObservedSessionDelta | undefined {
  if (!isObject(batch)) return undefined;
  return batchCollectors.get(batch)?.delta();
}

/** Registers a transaction session keyed to the callback passed to `runTransaction`. */
export function beginAdminTransactionSession(callback: unknown): AdminTransactionSession {
  const session: AdminTransactionSession = { kind: 'admin-tx-session', currentAttempt: undefined };
  if (typeof callback === 'function') txSessionsByCallback.set(callback, session);
  return session;
}

/** Reads the winning attempt's delta after `Firestore.runTransaction` commits `ok`. */
export function commitAdminTransactionDelta(subject: unknown): ObservedSessionDelta | undefined {
  if (!isObject(subject) || subject.kind !== 'admin-tx-session') return undefined;
  const session = subject as unknown as AdminTransactionSession;
  return session.currentAttempt?.delta();
}

/** Patches `WriteBatch.prototype` once so staged writes emit on successful `commit()`. */
export function patchAdminFirestoreWriteBatch(prototype: object | undefined): void {
  if (prototype === undefined || Object.hasOwn(prototype, BATCH_PATCHED)) return;
  const writeMethods: readonly WriteMethodName[] = ['create', 'set', 'update', 'delete'];
  for (const method of writeMethods) {
    patchMethod(prototype, method, (real) => function stagedBatchWrite(this: unknown, ...args: unknown[]): unknown {
      const result = Reflect.apply(real, this, args);
      if (isObject(this) && !txOwnedBatches.has(this)) {
        let collector = batchCollectors.get(this);
        if (collector === undefined) {
          collector = new DeltaOps();
          batchCollectors.set(this, collector);
        }
        recordStagedWrite(collector, method, args);
      }
      return result;
    });
  }
  patchMethod(prototype, '_reset', (real) => function resetBatchSession(this: unknown, ...args: unknown[]): unknown {
    const result = Reflect.apply(real, this, args);
    if (isObject(this)) batchCollectors.delete(this);
    return result;
  });
  Object.defineProperty(prototype, BATCH_PATCHED, { value: true });
}

function recordAttemptGet(collector: DeltaOps, target: unknown, snap: unknown): void {
  if (hasAdminCustomConverter(target) || hasAdminQueryProjection(target)) {
    if (!collector.refusesMore()) collector.skip('unsupported');
    return;
  }
  if (isAdminDocumentSnapshot(snap)) {
    if (collector.refusesMore()) return;
    addAdminDocSnapshot(collector, snap, docPathOfAdminRef(target), target);
    return;
  }
  if (isObject(snap) && Array.isArray(snap.docs)) {
    addAdminQuerySnapshot(collector, snap, false);
  }
}

function recordAttemptGetAll(collector: DeltaOps, args: readonly unknown[], snaps: unknown): void {
  const parsed = parseAdminGetAllCall(args);
  if (parsed.hasFieldMask) {
    if (!collector.refusesMore()) collector.skip('unsupported');
    return;
  }
  if (!Array.isArray(snaps)) return;
  addAdminSnapshotBatch(collector, snaps, parsed.docRefs);
}

function attemptOf(tx: unknown): DeltaOps | undefined {
  if (!isObject(tx)) return undefined;
  return txAttempts.get(tx);
}

function sessionOfCallback(callback: unknown): AdminTransactionSession | undefined {
  if (typeof callback !== 'function') return undefined;
  return txSessionsByCallback.get(callback);
}

/**
 * Patches `Transaction.prototype` once so each `runTransactionOnce` attempt gets
 * an isolated collector whose reads and staged writes emit only if the outer
 * `Firestore.runTransaction` commits `ok`.
 */
export function patchAdminFirestoreTransaction(prototype: object | undefined): void {
  if (prototype === undefined || Object.hasOwn(prototype, TX_PATCHED)) return;

  patchMethod(prototype, 'runTransactionOnce', (real) => function trackedAttempt(this: unknown, ...args: unknown[]): unknown {
    const session = sessionOfCallback(args[0]);
    if (session !== undefined && isObject(this)) {
      const innerBatch = this._writeBatch;
      if (isObject(innerBatch)) txOwnedBatches.add(innerBatch);
      const attempt = new DeltaOps();
      session.currentAttempt = attempt;
      txAttempts.set(this, attempt);
    }
    return Reflect.apply(real, this, args);
  });

  patchMethod(prototype, 'get', (real) => function trackedTxGet(this: unknown, ...args: unknown[]): unknown {
    const pending = Reflect.apply(real, this, args);
    const attempt = attemptOf(this);
    if (attempt === undefined || !(pending instanceof Promise)) return pending;
    return pending.then((snap: unknown) => {
      recordAttemptGet(attempt, args[0], snap);
      return snap;
    });
  });

  patchMethod(prototype, 'getAll', (real) => function trackedTxGetAll(this: unknown, ...args: unknown[]): unknown {
    const pending = Reflect.apply(real, this, args);
    const attempt = attemptOf(this);
    if (attempt === undefined || !(pending instanceof Promise)) return pending;
    return pending.then((snaps: unknown) => {
      recordAttemptGetAll(attempt, args, snaps);
      return snaps;
    });
  });

  const writeMethods: readonly WriteMethodName[] = ['create', 'set', 'update', 'delete'];
  for (const method of writeMethods) {
    patchMethod(prototype, method, (real) => function trackedTxWrite(this: unknown, ...args: unknown[]): unknown {
      const result = Reflect.apply(real, this, args);
      const attempt = attemptOf(this);
      if (attempt !== undefined) recordStagedWrite(attempt, method, args);
      return result;
    });
  }

  Object.defineProperty(prototype, TX_PATCHED, { value: true });
}
