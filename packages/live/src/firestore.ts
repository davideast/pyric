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
 * A list or listener whose first argument is a query or collection also
 * carries the query's shape (`queryShape` below): never a filter or cursor
 * value, only the realm's keyed hash of them (`keyed-hash.ts`).
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
import {
  observedCall,
  projectOf,
  type CallContext,
  type LiveQuery,
  type LiveQueryFilter,
  type LiveQueryOrder,
  type LiveUsage,
  type ObservedSite,
  type ListenerIdentity,
  type ResultReading,
} from './observe.js';
import { realmHash } from './keyed-hash.js';

/** Where a reference or query sits: its path or group id, and the key its listeners share. */
export interface FirestorePath {
  readonly target: string;
  readonly key: string;
}

const WRITES: ReadonlySet<string> = new Set(['setDoc', 'updateDoc', 'addDoc']);

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

/** The operators a host takes on a filter. */
const QUERY_OPERATORS: ReadonlySet<string> = new Set(['<', '<=', '==', '!=', '>=', '>', 'array-contains', 'in', 'not-in', 'array-contains-any']);
/** The most filters or orders a host takes on one query. */
const MAX_QUERY_CLAUSES = 64;
/** The longest field path a host takes. */
const MAX_FIELD_LENGTH = 1500;
/*
 * The host's token test, mirrored from `isTokenShaped` in pyric's
 * `sandbox/internal/observed-call.ts`, which the page cannot import: runs of
 * URL-safe characters and colons, refused when a colon-free segment is a
 * JWT's start (`eyJ` and 10 more characters) or a 40-character run with a
 * digit, or two segments make an FCM token. Keep the two in step.
 */
const NON_TOKEN_CHARACTERS = /[^A-Za-z0-9_:-]+/;
const DIGIT = /[0-9]/;
const MIN_JWT_TAIL = 10;
const MIN_FCM_ID = 8;
const MIN_FCM_TAIL = 20;
const MIN_OPAQUE_RUN = 40;

function isTokenSegment(segment: string): boolean {
  const jwtStart = segment.indexOf('eyJ');
  const isJwt = jwtStart >= 0 && segment.length - jwtStart - 3 >= MIN_JWT_TAIL;
  const isOpaque = segment.length >= MIN_OPAQUE_RUN && DIGIT.test(segment);
  return isJwt || isOpaque;
}

function isTokenRun(run: string): boolean {
  const segments = run.split(':');
  return segments.some((segment, index) => {
    const next = segments[index + 1];
    const isFcmToken = next !== undefined && segment.length >= MIN_FCM_ID && next.length >= MIN_FCM_TAIL;
    return isFcmToken || isTokenSegment(segment);
  });
}

function isTokenShaped(value: string): boolean {
  return value.split(NON_TOKEN_CHARACTERS).some(isTokenRun);
}

/** Thrown inside the shape reader for a part the host would refuse: the shape is dropped, the row kept. */
const UNSENDABLE: unique symbol = Symbol('unsendable');

/**
 * A field path as the SDK keeps it, when the host would take it. Any `@`
 * drops it, wider than the host's email test, so a field the host refuses
 * never reaches it.
 */
function sendableField(field: unknown): string {
  const path = canonicalPath(field);
  const isBounded = typeof path === 'string' && path.length > 0 && path.length <= MAX_FIELD_LENGTH;
  if (!isBounded) throw UNSENDABLE;
  const isValueShaped = path.includes('@') || isTokenShaped(path);
  if (isValueShaped) throw UNSENDABLE;
  return path;
}

/** One SDK filter as field filters, its values pushed onto `values`. An `or` or `and` composite flattens into its parts. */
function flattenFilter(filter: unknown, filters: LiveQueryFilter[], values: unknown[]): void {
  if (!isObject(filter)) throw UNSENDABLE;
  const parts: unknown = Reflect.get(filter, 'filters');
  if (Array.isArray(parts)) {
    for (const part of parts) flattenFilter(part, filters, values);
    return;
  }
  const op: unknown = Reflect.get(filter, 'op');
  const isOperator = typeof op === 'string' && QUERY_OPERATORS.has(op);
  if (!isOperator) throw UNSENDABLE;
  filters.push({ field: sendableField(Reflect.get(filter, 'field')), op: op as LiveQueryFilter['op'] });
  values.push(Reflect.get(filter, 'value'));
}

function readOrder(order: unknown): LiveQueryOrder {
  if (!isObject(order)) throw UNSENDABLE;
  const direction: unknown = Reflect.get(order, 'dir');
  const isDirection = direction === 'asc' || direction === 'desc';
  if (!isDirection) throw UNSENDABLE;
  return { field: sendableField(Reflect.get(order, 'field')), direction };
}

/** A cursor's position and whether it includes it, or null for no cursor. */
function cursorOf(bound: unknown): unknown {
  if (!isObject(bound)) return null;
  return [Reflect.get(bound, 'position'), Reflect.get(bound, 'inclusive')];
}

/**
 * The realm's keyed hash of a query's filter and cursor values
 * (`keyed-hash.ts`), or nothing when they don't serialize: fingerprints
 * match within one page or process, and no value can be checked against one
 * elsewhere.
 */
function valuesFingerprint(values: unknown): Pick<LiveQuery, 'fingerprint'> {
  try {
    return { fingerprint: realmHash(JSON.stringify(values)) };
  } catch {
    // Values that do not serialize leave the shape without a fingerprint.
    return {};
  }
}

/** The shape of a query the SDK keeps in its `_query`; throws `UNSENDABLE` for one the host would refuse. */
function readShape(query: object): LiveQuery {
  const sdkFilters: unknown = Reflect.get(query, 'filters');
  const sdkOrders: unknown = Reflect.get(query, 'explicitOrderBy');
  const isReadable = Array.isArray(sdkFilters) && Array.isArray(sdkOrders);
  if (!isReadable) throw UNSENDABLE;
  const filters: LiveQueryFilter[] = [];
  const values: unknown[] = [];
  for (const filter of sdkFilters) flattenFilter(filter, filters, values);
  const orderBy = sdkOrders.map(readOrder);
  const isBounded = filters.length <= MAX_QUERY_CLAUSES && orderBy.length <= MAX_QUERY_CLAUSES;
  if (!isBounded) throw UNSENDABLE;
  const startAt = cursorOf(Reflect.get(query, 'startAt'));
  const endAt = cursorOf(Reflect.get(query, 'endAt'));
  const hasValues = values.length > 0 || startAt !== null || endAt !== null;
  const isGroup = typeof Reflect.get(query, 'collectionGroup') === 'string';
  const hasLimit = typeof Reflect.get(query, 'limit') === 'number';
  return {
    scope: isGroup ? 'collection-group' : 'collection',
    ...(filters.length === 0 ? {} : { filters }),
    ...(orderBy.length === 0 ? {} : { orderBy }),
    ...(hasLimit ? { limit: true as const } : {}),
    ...(hasValues ? valuesFingerprint([values, startAt, endAt]) : {}),
  };
}

/** The SDK `type` of a first argument that runs as a query: a `Query` or a `CollectionReference`. */
const QUERY_TYPES: ReadonlySet<unknown> = new Set(['query', 'collection']);

/**
 * The shape of the query a list or listener ran: its scope, its filters'
 * fields and operators (an `or` flattened into its parts), its orders,
 * whether it set a limit, and the realm's keyed hash of its filter and cursor values,
 * so no value leaves the page. Undefined for a write or a document call, and
 * for a query with a field path the host would refuse as value-shaped, whose
 * row is still recorded without it.
 */
export function queryShape(name: string, subject: unknown): LiveQuery | undefined {
  const isQuery = isObject(subject) && !WRITES.has(name) && QUERY_TYPES.has(Reflect.get(subject, 'type'));
  if (!isQuery) return undefined;
  const query: unknown = Reflect.get(subject, '_query');
  if (!isObject(query)) return undefined;
  try {
    return readShape(query);
  } catch {
    // A part the host would refuse, or an SDK that renamed one, drops the shape, never the row.
    return undefined;
  }
}

/** A reference's path, or a query's, read without calling anything of the app's. `type` is the subject's SDK `type`. */
export function firestorePath(subject: object, type: unknown): FirestorePath | undefined {
  const isReference = type === 'document' || type === 'collection';
  if (!isReference) return type === 'query' ? queryPath(subject) : undefined;
  const path: unknown = Reflect.get(subject, 'path');
  return typeof path === 'string' ? { target: path, key: JSON.stringify([type, path]) } : undefined;
}

/** The document a resumed snapshot names: a `DocumentSnapshot`'s `toJSON()` keeps its path as `bundleName`. */
function resumedDocument(snapshotJson: unknown): ListenerIdentity | undefined {
  if (!isObject(snapshotJson)) return undefined;
  const source: unknown = Reflect.get(snapshotJson, 'bundleSource');
  const path: unknown = Reflect.get(snapshotJson, 'bundleName');
  const isDocument = source === 'DocumentSnapshot' && typeof path === 'string' && path !== '';
  return isDocument ? { target: path, key: JSON.stringify(['document', path]) } : undefined;
}

/**
 * What one `onSnapshot` listens to: the reference's or query's path and the
 * key the page's journal gives it. An `onSnapshotResume` of a document
 * snapshot listens to that document; a resumed query snapshot names only a
 * random bundle id, so it gets no lifecycle.
 */
export function firestoreListener(name: string, args: readonly unknown[]): ListenerIdentity | undefined {
  if (name === 'onSnapshotResume') return resumedDocument(args[1]);
  const subject = args[0];
  if (!isObject(subject)) return undefined;
  return firestorePath(subject, Reflect.get(subject, 'type'));
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
 * on a write, the fields it wrote; on a list or listener, its query's shape.
 */
export function firestoreContext(name: string, args: readonly unknown[]): CallContext {
  const projectId = projectOf(args);
  const project = projectId === undefined ? {} : { projectId };
  try {
    const subject = args[0];
    const path = pathOf(subject);
    const writeData = writeDataOf(name, args);
    const query = queryShape(name, subject);
    return {
      subject,
      ...project,
      ...(path === undefined ? {} : { path }),
      ...(writeData === undefined ? {} : { writeData }),
      ...(query === undefined ? {} : { query }),
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
