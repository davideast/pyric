/**
 * What the live-firestore row reads off the SDK's own objects: the path a
 * reference or query names, and the context of one call, so a record names
 * the document or collection the call touched the way a sandbox row does.
 *
 * A `DocumentReference` or `CollectionReference` names its `path`. A `Query`
 * names its collection's path, or its group id for a collection-group query,
 * read from the SDK's `_query`. A call whose first argument is the Firestore
 * itself (`runTransaction`) names no path. Only paths are read, never a
 * filter's value or a document's data.
 *
 * Reading never calls the app's code and never throws. Loaded in the page
 * too, so it imports only types.
 */
import type { CallContext } from './observe.js';

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

/**
 * The record context of one call: the first argument, whose app names the
 * account; the project its app names, through a reference or query's
 * `firestore.app` or the Firestore's own `app`; and the path it touched.
 */
export function firestoreContext(_name: string, args: readonly unknown[]): CallContext {
  try {
    const subject = args[0];
    const projectId = stringAt(subject, ['firestore', 'app', 'options', 'projectId']) ?? stringAt(subject, ['app', 'options', 'projectId']);
    const path = pathOf(subject);
    return {
      subject,
      ...(projectId === undefined ? {} : { projectId }),
      ...(path === undefined ? {} : { path }),
    };
  } catch {
    // An argument that throws on read is still recorded, without its context.
    return { subject: args[0] };
  }
}
