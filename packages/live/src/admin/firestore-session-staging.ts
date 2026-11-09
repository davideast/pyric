/**
 * Bounded delta collection and staged `WriteBatch` / `Transaction` session
 * capture for `@google-cloud/firestore`.
 *
 * `WriteBatch` operations stage into a per-batch collector and emit only when
 * `WriteBatch.commit` resolves `ok`. `Transaction` operations stage into an
 * attempt-scoped collector recreated on every `runTransactionOnce` retry so
 * failed or rolled-back attempts never leak into session memory.
 */
import { isValidDocPath, normalizeDocPath, type SessionCopyResult } from '../firestore-session-values.js';
import { isPlainObject } from '../json-copy.js';
import { MAX_SESSION_DELTA_BYTES, MAX_SESSION_ITEM_BYTES, type SessionBudget } from '../session-budget.js';
import {
  sessionDeltaOf,
  skipCountsOf,
  type ObservedFirestoreSessionOp,
  type ObservedSessionDelta,
} from '../session-data.js';
import {
  adminCreateDocOp,
  adminDocFields,
  adminSetDocOp,
  adminUpdateDocOp,
} from './firestore-session-values.js';
import { keepShape } from './patch.js';

const MAX_SESSION_DOCS = 250;
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
  currentAttempt: AdminDeltaCollector | undefined;
}

/** Collects ops for one delta under the 250-doc and 512-KiB session bounds. */
export class AdminDeltaCollector {
  readonly ops: ObservedFirestoreSessionOp[] = [];
  private readonly budget: SessionBudget = { left: MAX_SESSION_DELTA_BYTES };
  private oversized = 0;
  private unsupported = 0;
  private truncated = 0;
  private isCutOff = false;

  refusesMore(): boolean {
    const isFull = this.isCutOff || this.ops.length >= MAX_SESSION_DOCS || this.budget.left <= 0;
    if (isFull) {
      this.truncated += 1;
      this.isCutOff = true;
    }
    return isFull;
  }

  add(copy: (budget: SessionBudget) => SessionCopyResult<ObservedFirestoreSessionOp>): boolean {
    const cap = Math.min(MAX_SESSION_ITEM_BYTES, this.budget.left);
    const itemBudget: SessionBudget = { left: cap };
    const op = copy(itemBudget);
    this.budget.left -= Math.max(0, cap - Math.max(0, itemBudget.left));
    if (op.ok) {
      this.ops.push(op.value);
      return true;
    }
    if (op.reason === 'oversized' && cap < MAX_SESSION_ITEM_BYTES) {
      this.truncated += 1;
      this.isCutOff = true;
      return false;
    }
    this.skip(op.reason);
    return true;
  }

  skip(reason: 'oversized' | 'unsupported'): void {
    if (reason === 'oversized') this.oversized += 1;
    else this.unsupported += 1;
  }

  truncateRemaining(count: number): void {
    if (count > 0) {
      this.truncated += count;
      this.isCutOff = true;
    }
  }

  delta(): ObservedSessionDelta | undefined {
    return sessionDeltaOf({
      firestore: [...this.ops],
      skipped: skipCountsOf(this.oversized, this.unsupported, this.truncated),
    });
  }
}

const defaultConverters = new WeakMap<object, unknown>();
const batchCollectors = new WeakMap<object, AdminDeltaCollector>();
const txOwnedBatches = new WeakSet<object>();
const txSessionsByCallback = new WeakMap<Function, AdminTransactionSession>();
const txAttempts = new WeakMap<object, AdminDeltaCollector>();

function isObject(value: unknown): value is object {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

function ownerFirestoreOf(target: unknown): object | undefined {
  if (!isObject(target)) return undefined;
  const direct: unknown = Reflect.get(target, '_firestore');
  if (isObject(direct)) return direct;
  const ref: unknown = Reflect.get(target, 'ref');
  if (isObject(ref)) {
    const fromRef: unknown = Reflect.get(ref, '_firestore');
    if (isObject(fromRef)) return fromRef;
  }
  const query: unknown = Reflect.get(target, 'query');
  if (isObject(query)) {
    const fromQuery: unknown = Reflect.get(query, '_firestore');
    if (isObject(fromQuery)) return fromQuery;
  }
  return undefined;
}

function defaultConverterOf(firestore: object | undefined): unknown {
  if (firestore === undefined) return undefined;
  if (defaultConverters.has(firestore)) return defaultConverters.get(firestore);
  const docFn: unknown = Reflect.get(firestore, 'doc');
  if (typeof docFn !== 'function') return undefined;
  try {
    const probeRef: unknown = Reflect.apply(docFn, firestore, ['__pyric_default__/probe']);
    if (!isObject(probeRef)) return undefined;
    const def: unknown = Reflect.get(probeRef, '_converter');
    defaultConverters.set(firestore, def);
    return def;
  } catch {
    return undefined;
  }
}

function rawConverterOf(target: unknown): unknown {
  if (!isObject(target)) return undefined;
  const queryOpts: unknown = Reflect.get(target, '_queryOptions');
  if (isObject(queryOpts) && Reflect.get(queryOpts, 'converter') !== undefined) {
    return Reflect.get(queryOpts, 'converter');
  }
  const direct: unknown = Reflect.get(target, '_converter');
  if (direct !== undefined) return direct;
  const ref: unknown = Reflect.get(target, 'ref');
  if (isObject(ref) && Reflect.get(ref, '_converter') !== undefined) {
    return Reflect.get(ref, '_converter');
  }
  const query: unknown = Reflect.get(target, 'query');
  if (isObject(query)) {
    const snapQueryOpts: unknown = Reflect.get(query, '_queryOptions');
    if (isObject(snapQueryOpts) && Reflect.get(snapQueryOpts, 'converter') !== undefined) {
      return Reflect.get(snapQueryOpts, 'converter');
    }
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

export function docPathOfAdminRef(ref: unknown): string | undefined {
  if (!isObject(ref)) return undefined;
  const rawPath: unknown = Reflect.get(ref, 'path');
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
  if (typeof Reflect.get(value, 'data') !== 'function') return false;
  const existsProp: unknown = Reflect.get(value, 'exists');
  return typeof existsProp === 'boolean' || typeof existsProp === 'function';
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

export function addAdminDocSnapshot(
  collector: AdminDeltaCollector,
  docSnap: unknown,
  fallbackPath?: string,
  sourceRef?: unknown,
): boolean {
  if (!isObject(docSnap) || hasAdminCustomConverter(sourceRef) || hasAdminCustomConverter(docSnap)) {
    collector.skip('unsupported');
    return true;
  }
  const path = docSnapPathOf(docSnap, fallbackPath);
  if (path === undefined) {
    collector.skip('unsupported');
    return true;
  }
  if (!adminSnapshotExists(docSnap)) {
    return collector.add(() => ({ ok: true, value: { kind: 'delete', path } }));
  }
  const dataFn: unknown = Reflect.get(docSnap, 'data');
  if (typeof dataFn !== 'function') {
    collector.skip('unsupported');
    return true;
  }
  return collector.add((budget) => {
    const fields = adminDocFields(Reflect.apply(dataFn, docSnap, []), budget);
    if (!fields.ok) return fields;
    return { ok: true, value: { kind: 'set', path, data: fields.value } };
  });
}

function changedQueryDocuments(snap: object): unknown[] | undefined {
  const docChangesFn: unknown = Reflect.get(snap, 'docChanges');
  if (typeof docChangesFn !== 'function') return undefined;
  const changes: unknown = Reflect.apply(docChangesFn, snap, []);
  if (!Array.isArray(changes)) return undefined;
  const docs: unknown[] = [];
  for (const change of changes) {
    if (!isObject(change)) continue;
    const changeType: unknown = Reflect.get(change, 'type');
    if (changeType === 'added' || changeType === 'modified') docs.push(Reflect.get(change, 'doc'));
  }
  return docs;
}

export function addAdminQuerySnapshot(
  collector: AdminDeltaCollector,
  snap: object,
  useChanges: boolean,
): void {
  if (hasAdminCustomConverter(snap)) {
    collector.skip('unsupported');
    return;
  }
  let documents: unknown;
  if (useChanges) documents = changedQueryDocuments(snap);
  if (documents === undefined) documents = Reflect.get(snap, 'docs');
  if (!Array.isArray(documents)) return;
  for (let i = 0; i < documents.length; i++) {
    if (collector.refusesMore()) {
      collector.truncateRemaining(documents.length - i - 1);
      break;
    }
    if (!addAdminDocSnapshot(collector, documents[i])) {
      collector.truncateRemaining(documents.length - i - 1);
      break;
    }
  }
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

function recordStagedWrite(collector: AdminDeltaCollector, method: WriteMethodName, args: readonly unknown[]): void {
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
  if (!isObject(subject) || Reflect.get(subject, 'kind') !== 'admin-tx-session') return undefined;
  const session = subject as AdminTransactionSession;
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
          collector = new AdminDeltaCollector();
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

function recordAttemptGet(collector: AdminDeltaCollector, target: unknown, snap: unknown): void {
  if (hasAdminCustomConverter(target)) {
    if (!collector.refusesMore()) collector.skip('unsupported');
    return;
  }
  if (isAdminDocumentSnapshot(snap)) {
    if (collector.refusesMore()) return;
    addAdminDocSnapshot(collector, snap, docPathOfAdminRef(target), target);
    return;
  }
  if (isObject(snap) && Array.isArray(Reflect.get(snap, 'docs'))) {
    addAdminQuerySnapshot(collector, snap, false);
  }
}

function recordAttemptGetAll(collector: AdminDeltaCollector, args: readonly unknown[], snaps: unknown): void {
  const parsed = parseAdminGetAllCall(args);
  if (parsed.hasFieldMask) {
    if (!collector.refusesMore()) collector.skip('unsupported');
    return;
  }
  if (!Array.isArray(snaps)) return;
  for (let i = 0; i < snaps.length; i++) {
    if (collector.refusesMore()) {
      collector.truncateRemaining(snaps.length - i - 1);
      break;
    }
    const ref = parsed.docRefs[i];
    if (!addAdminDocSnapshot(collector, snaps[i], docPathOfAdminRef(ref), ref)) {
      collector.truncateRemaining(snaps.length - i - 1);
      break;
    }
  }
}

function attemptOf(tx: unknown): AdminDeltaCollector | undefined {
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
      const innerBatch: unknown = Reflect.get(this, '_writeBatch');
      if (isObject(innerBatch)) txOwnedBatches.add(innerBatch);
      const attempt = new AdminDeltaCollector();
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
