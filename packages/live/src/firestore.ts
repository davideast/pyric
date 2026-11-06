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
 * document it returned, each as a JSON copy. Data that is not plain JSON (a
 * sentinel such as `serverTimestamp()`, a Timestamp, a reference) carries
 * none, nor does a merge `setDoc` or a dotted `updateDoc` field path, whose
 * fields are not the document's.
 *
 * Reading never calls the app's code and never throws. Loaded in the page
 * too, so it imports only types.
 */
import type { CallContext, ObservedSite, ResultReading } from './observe.js';

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

function stringAt(value: unknown, keys: readonly string[]): string | undefined {
  let current = value;
  for (const key of keys) {
    if (!isObject(current)) return undefined;
    current = Reflect.get(current, key);
  }
  return typeof current === 'string' && current !== '' ? current : undefined;
}

/** The path the first argument names, when it is a reference or query. */
function pathOf(subject: unknown): string | undefined {
  if (!isObject(subject)) return undefined;
  return firestorePath(subject, Reflect.get(subject, 'type'))?.target;
}

/** The deepest nesting a JSON copy keeps; the host refuses deeper. */
const MAX_DEPTH = 20;

const NOT_JSON: unique symbol = Symbol('not-json');

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A JSON copy of a value, or `NOT_JSON` when it holds anything else. */
function jsonCopy(value: unknown, depth: number): unknown {
  const isScalar = value === null || typeof value === 'string' || typeof value === 'boolean';
  if (isScalar) return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : NOT_JSON;
  const isNested = isObject(value) && depth < MAX_DEPTH;
  if (!isNested) return NOT_JSON;
  if (Array.isArray(value)) {
    const items = value.map((item: unknown) => jsonCopy(item, depth + 1));
    return items.includes(NOT_JSON) ? NOT_JSON : items;
  }
  if (!isPlainObject(value)) return NOT_JSON;
  const entries = Object.entries(value).map(([key, field]) => [key, jsonCopy(field, depth + 1)] as const);
  const isJson = entries.every(([, field]) => field !== NOT_JSON);
  return isJson ? Object.fromEntries(entries) : NOT_JSON;
}

/** A JSON copy of a document's fields, or undefined when they are not plain JSON. */
function jsonFields(value: unknown): Record<string, unknown> | undefined {
  const isFields = isObject(value) && !Array.isArray(value);
  if (!isFields) return undefined;
  const copy = jsonCopy(value, 0);
  return copy === NOT_JSON ? undefined : (copy as Record<string, unknown>);
}

const WRITES: ReadonlySet<string> = new Set(['setDoc', 'updateDoc', 'addDoc']);

/** Whether `setDoc`'s options merge into the stored document, so the written fields are not the document's. */
function isMerge(options: unknown): boolean {
  if (!isObject(options)) return false;
  return Reflect.get(options, 'merge') === true || Reflect.get(options, 'mergeFields') !== undefined;
}

/** The fields a write sent, as its second argument names them, when they are the document's own. */
function writeDataOf(name: string, args: readonly unknown[]): Record<string, unknown> | undefined {
  if (!WRITES.has(name)) return undefined;
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
  try {
    const subject = args[0];
    const projectId = stringAt(subject, ['firestore', 'app', 'options', 'projectId']) ?? stringAt(subject, ['app', 'options', 'projectId']);
    const path = pathOf(subject);
    const writeData = writeDataOf(name, args);
    return {
      subject,
      ...(projectId === undefined ? {} : { projectId }),
      ...(path === undefined ? {} : { path }),
      ...(writeData === undefined ? {} : { writeData }),
    };
  } catch {
    // An argument that throws on read is still recorded, without its context.
    return { subject: args[0] };
  }
}

const DOCUMENT_READS: ReadonlySet<string> = new Set(['getDoc', 'getDocFromServer']);

/**
 * What a resolved document read adds to its record: the fields of the
 * document it returned, read through the snapshot's own `data()`, or
 * nothing for a missing document or one that is not plain JSON.
 */
export function firestoreResult(site: ObservedSite, value: unknown): ResultReading {
  if (!DOCUMENT_READS.has(site.name) || !isObject(value)) return {};
  const data: unknown = Reflect.get(value, 'data');
  if (typeof data !== 'function') return {};
  const document = jsonFields(Reflect.apply(data, value, []));
  return document === undefined ? {} : { document };
}
