/**
 * What the live-firestore row reads off the SDK's own objects: the path a
 * reference or query names, and the context of one call, so a record names
 * the document or collection the call touched the way a sandbox row does.
 *
 * A `DocumentReference` or `CollectionReference` names its `path`. A `Query`
 * names its collection's path, or its group id for a collection-group query,
 * read from the SDK's `_query`. A call whose first argument is the Firestore
 * itself (`runTransaction`) names no path. A filter's value is never read.
 *
 * For the host's local rules only, a `setDoc`, `updateDoc` or `addDoc` also
 * carries the fields it wrote, and a resolved `getDoc` the fields of the
 * document it returned, each as a JSON copy of at most the 64 KiB a host
 * keeps. Data that is not plain JSON (a sentinel such as `serverTimestamp()`,
 * a Timestamp, a reference) or is larger carries none, nor does a merge
 * `setDoc` or a dotted `updateDoc` field path, whose fields are not the
 * document's. A reference or query with a converter (`withConverter`) carries
 * neither: its data is the app's model, not the stored fields, and reading
 * it would run the app's `fromFirestore`.
 *
 * A `writeBatch` is observed at its `commit`: the batch counts each `set`,
 * `update` and `delete` the SDK accepted, and the commit is one observed
 * `writeBatch` call whose usage names those writes and deletes, with the
 * project and account of the Firestore `writeBatch` was handed. The batch
 * stays the SDK's own object, with own-property wrappers.
 *
 * Reading never calls the app's code and never throws. Loaded in the page
 * too. From observe.ts, which imports this file through listener-journal.ts,
 * it takes types and `projectOf`, a function declaration that runs only when
 * a call is read, so the cycle resolves at load.
 */
import { observedCall, projectOf, type CallContext, type LiveUsage, type ObservedSite, type ResultReading } from './observe.js';

/** Where a reference or query sits: its path or group id, and the key its listeners share. */
export interface FirestorePath {
  readonly target: string;
  readonly key: string;
}

/** The constraints of a query, as the SDK keeps them in its `_query`. */
const QUERY_CONSTRAINTS = ['filters', 'explicitOrderBy', 'limit', 'limitType', 'startAt', 'endAt'] as const;

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/** The collection path a query's SDK `path` names, or undefined when it names none. */
function canonicalPath(path: unknown): unknown {
  if (!isObject(path)) return undefined;
  const canonical: unknown = Reflect.get(path, 'canonicalString');
  return typeof canonical === 'function' ? Reflect.apply(canonical, path, []) : undefined;
}

/** A query's collection path or group id, and its key, read from the SDK's `_query`. */
function queryPath(subject: object): FirestorePath | undefined {
  const query: unknown = Reflect.get(subject, '_query');
  if (!isObject(query)) return undefined;
  const group: unknown = Reflect.get(query, 'collectionGroup');
  const target = typeof group === 'string' ? group : canonicalPath(Reflect.get(query, 'path'));
  if (typeof target !== 'string') return undefined;
  const constraints = QUERY_CONSTRAINTS.map((name) => Reflect.get(query, name));
  try {
    return { target, key: JSON.stringify(['query', target, constraints]) };
  } catch {
    // Constraints that do not serialize key the query by its collection alone.
    return { target, key: JSON.stringify(['query', target]) };
  }
}

/** A reference's path, or a query's, read without calling anything of the app's. `type` is the subject's SDK `type`. */
export function firestorePath(subject: object, type: unknown): FirestorePath | undefined {
  const isReference = type === 'document' || type === 'collection';
  if (!isReference) return type === 'query' ? queryPath(subject) : undefined;
  const path: unknown = Reflect.get(subject, 'path');
  return typeof path === 'string' ? { target: path, key: JSON.stringify([type, path]) } : undefined;
}

/** The path the first argument names, when it is a reference or query. */
function pathOf(subject: unknown): string | undefined {
  if (!isObject(subject)) return undefined;
  return firestorePath(subject, Reflect.get(subject, 'type'))?.target;
}

/** The deepest nesting a JSON copy keeps; the host refuses deeper. */
const MAX_DEPTH = 20;
/** The most a host keeps of written data or a returned document, as it measures it: a string's length plus 2, a key's plus 4, any other scalar 8. */
const MAX_FIELDS_SIZE = 64 * 1024;

interface Budget {
  left: number;
}

const NOT_JSON: unique symbol = Symbol('not-json');

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A JSON copy of a value, or `NOT_JSON` when it holds anything else or runs past the budget. */
function jsonCopy(value: unknown, depth: number, budget: Budget): unknown {
  if (typeof value === 'string') {
    budget.left -= value.length + 2;
    return value;
  }
  const isScalar = value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
  if (isScalar) {
    budget.left -= 8;
    return value;
  }
  const isNested = isObject(value) && depth < MAX_DEPTH;
  if (!isNested) return NOT_JSON;
  if (Array.isArray(value)) return jsonItems(value, depth, budget);
  return isPlainObject(value) ? jsonEntries(value, depth, budget) : NOT_JSON;
}

function jsonItems(items: readonly unknown[], depth: number, budget: Budget): unknown {
  const copy: unknown[] = [];
  for (const item of items) {
    const copied = jsonCopy(item, depth + 1, budget);
    if (copied === NOT_JSON || budget.left < 0) return NOT_JSON;
    copy.push(copied);
  }
  return copy;
}

function jsonEntries(fields: object, depth: number, budget: Budget): unknown {
  const entries: [string, unknown][] = [];
  for (const [key, field] of Object.entries(fields)) {
    budget.left -= key.length + 4;
    const copied = jsonCopy(field, depth + 1, budget);
    if (copied === NOT_JSON || budget.left < 0) return NOT_JSON;
    entries.push([key, copied]);
  }
  return Object.fromEntries(entries);
}

/** A JSON copy of a document's fields, or undefined when they are not plain JSON or larger than a host keeps. */
function jsonFields(value: unknown): Record<string, unknown> | undefined {
  const isFields = isObject(value) && !Array.isArray(value);
  if (!isFields) return undefined;
  const copy = jsonCopy(value, 0, { left: MAX_FIELDS_SIZE });
  return copy === NOT_JSON ? undefined : (copy as Record<string, unknown>);
}

/** Whether a reference or query reads and writes through the app's converter (`withConverter`). */
function hasConverter(subject: unknown): boolean {
  if (!isObject(subject)) return false;
  const converter: unknown = Reflect.get(subject, 'converter');
  return converter !== null && converter !== undefined;
}

const WRITES: ReadonlySet<string> = new Set(['setDoc', 'updateDoc', 'addDoc']);

/** Whether `setDoc`'s options merge into the stored document, so the written fields are not the document's. */
function isMerge(options: unknown): boolean {
  if (!isObject(options)) return false;
  return Reflect.get(options, 'merge') === true || Reflect.get(options, 'mergeFields') !== undefined;
}

/** The fields a write sent, as its second argument names them, when they are the document's own. */
function writeDataOf(name: string, args: readonly unknown[]): Record<string, unknown> | undefined {
  if (!WRITES.has(name) || hasConverter(args[0])) return undefined;
  const merges = name === 'setDoc' && isMerge(args[2]);
  if (merges) return undefined;
  const data = jsonFields(args[1]);
  const isDotted = name === 'updateDoc' && data !== undefined && Object.keys(data).some((key) => key.includes('.'));
  return isDotted ? undefined : data;
}

/**
 * The record context of one call: the first argument, whose app names the
 * account; the project its app names, through a reference or query's
 * `firestore.app` or the Firestore's own `app`; the path it touched; and,
 * on a write, the fields it wrote.
 */
export function firestoreContext(name: string, args: readonly unknown[]): CallContext {
  const projectId = projectOf(args);
  const project = projectId === undefined ? {} : { projectId };
  try {
    const subject = args[0];
    const path = pathOf(subject);
    const writeData = writeDataOf(name, args);
    return {
      subject,
      ...project,
      ...(path === undefined ? {} : { path }),
      ...(writeData === undefined ? {} : { writeData }),
    };
  } catch {
    // An argument that throws on read is still recorded, with its project but without its path.
    return { subject: args[0], ...project };
  }
}

const DOCUMENT_READS: ReadonlySet<string> = new Set(['getDoc', 'getDocFromServer']);

/**
 * What a resolved document read adds to its record: the fields of the
 * document it returned, read through the snapshot's own `data()`, or
 * nothing for a missing document, one that is not plain JSON or too large,
 * or a reference with a converter, whose `data()` would run the app's code.
 */
export function firestoreResult(site: ObservedSite, value: unknown): ResultReading {
  const isPlainRead = DOCUMENT_READS.has(site.name) && !hasConverter(site.subject);
  if (!isPlainRead || !isObject(value)) return {};
  const data: unknown = Reflect.get(value, 'data');
  if (typeof data !== 'function') return {};
  const document = jsonFields(Reflect.apply(data, value, []));
  return document === undefined ? {} : { document };
}

type Callback = (this: unknown, ...args: unknown[]) => unknown;

/** The batch operations production bills, each as a write or a delete. */
const BATCH_OPERATIONS = [
  ['set', 'documentWrites'],
  ['update', 'documentWrites'],
  ['delete', 'documentDeletes'],
] as const;

interface BatchUsage {
  documentWrites: number;
  documentDeletes: number;
}

/** Replaces one of the batch's methods with an own property that calls the SDK's. */
function defineMethod(batch: object, name: string, method: Callback): void {
  Object.defineProperty(batch, name, { value: method, writable: true, configurable: true, enumerable: false });
}

/** Counts each operation the SDK accepted: one that throws (a bad argument, a committed batch) counts nothing. */
function countOperations(batch: object, usage: BatchUsage): void {
  for (const [name, kind] of BATCH_OPERATIONS) {
    const real: unknown = Reflect.get(batch, name);
    if (typeof real !== 'function') continue;
    defineMethod(batch, name, function counted(this: unknown, ...args: unknown[]): unknown {
      const returned = Reflect.apply(real, this, args);
      usage[kind] += 1;
      return returned;
    });
  }
}

/**
 * Makes the batch's `commit` one observed `writeBatch` call, with the usage
 * counted so far and the context of `writeBatch`'s arguments. The name stays
 * `writeBatch`: the senders' `measureObservedUsage` returns undefined for it,
 * so the counted usage stands, while `writeBatch.commit` would measure as
 * `unmeasured` and replace it.
 */
function observeCommit(batch: object, usage: BatchUsage, site: Omit<ObservedSite, 'name'>, args: readonly unknown[]): void {
  const real: unknown = Reflect.get(batch, 'commit');
  if (typeof real !== 'function') return;
  const context = (): CallContext => firestoreContext('writeBatch', args);
  defineMethod(batch, 'commit', function commit(this: unknown, ...commitArgs: unknown[]): unknown {
    const committed: LiveUsage = { ...usage };
    const observed = observedCall({ ...site, name: 'writeBatch', context, usage: committed }, real as Callback);
    return Reflect.apply(observed, this, commitArgs);
  });
}

/**
 * `writeBatch(firestore)`: the SDK's own batch, whose `set`, `update` and
 * `delete` count what the commit bills and whose `commit` is observed. A
 * batch the row cannot observe is still the SDK's own.
 */
export function observedWriteBatch(real: Callback, site: Omit<ObservedSite, 'name'>): Callback {
  return function writeBatch(this: unknown, ...args: unknown[]): unknown {
    const batch = Reflect.apply(real, this, args);
    try {
      if (isObject(batch)) {
        const usage: BatchUsage = { documentWrites: 0, documentDeletes: 0 };
        countOperations(batch, usage);
        observeCommit(batch, usage, site, args);
      }
    } catch {
      // Observing the batch never changes what the app gets.
    }
    return batch;
  };
}
