/**
 * Where a wrapped Firestore listener sits in the page's SDK activity journal.
 * The listener wrapper (`observe.ts`) reads the listener's target and key off
 * the reference or query the app passed, opens its activity through the
 * observer's `journal` (`@pyric/cli`'s `journalLiveListener` on a page), and
 * closes it when the app unsubscribes. Nothing here calls the app's own code,
 * and a failure here leaves the listener the SDK's own.
 *
 * Loaded in the page too, so it imports only types from `@pyric/cli`.
 */
import type { LiveListener, LiveListenerActivity } from '@pyric/cli/vite/internal/supplied-rows';

export type { LiveListener, LiveListenerActivity } from '@pyric/cli/vite/internal/supplied-rows';

/** Opens one listener's activity. */
export type LiveListenerJournal = (listener: LiveListener) => LiveListenerActivity;

type Callback = (this: unknown, ...values: unknown[]) => unknown;

/** The constraints of a query, as the SDK keeps them in its `_query`. */
const QUERY_CONSTRAINTS = ['filters', 'explicitOrderBy', 'limit', 'limitType', 'startAt', 'endAt'] as const;

/** The collection path a query's SDK `path` names, or undefined when it names none. */
function canonicalPath(path: unknown): unknown {
  const isObject = typeof path === 'object' && path !== null;
  if (!isObject) return undefined;
  const canonical: unknown = Reflect.get(path, 'canonicalString');
  return typeof canonical === 'function' ? Reflect.apply(canonical, path, []) : undefined;
}

/** A query's collection path or group id, and its key, read from the SDK's `_query`. */
function queryPath(subject: object): Pick<LiveListener, 'target' | 'key'> | undefined {
  const query: unknown = Reflect.get(subject, '_query');
  const isObject = typeof query === 'object' && query !== null;
  if (!isObject) return undefined;
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

/** A reference's path, or a query's, read without calling anything of the app's. */
function firestorePath(subject: object, type: unknown): Pick<LiveListener, 'target' | 'key'> | undefined {
  const isReference = type === 'document' || type === 'collection';
  if (!isReference) return type === 'query' ? queryPath(subject) : undefined;
  const path: unknown = Reflect.get(subject, 'path');
  return typeof path === 'string' ? { target: path, key: JSON.stringify([type, path]) } : undefined;
}

/** The Firestore listener an export's first argument names, or undefined for any other subject. */
function listenerOf(method: string, subject: unknown): LiveListener | undefined {
  const isObject = typeof subject === 'object' && subject !== null;
  if (!isObject) return undefined;
  const firestore: unknown = Reflect.get(subject, 'firestore');
  const hasFirestore = typeof firestore === 'object' && firestore !== null;
  if (!hasFirestore) return undefined;
  const type: unknown = Reflect.get(subject, 'type');
  const path = firestorePath(subject, type);
  if (path === undefined) return undefined;
  return { firestore, method, isQuery: type !== 'document', ...path };
}

/**
 * The listener's activity in the observer's journal, or undefined when the
 * observer has none, the subject is no Firestore reference or query, or
 * opening it failed.
 */
export function openActivity(
  observer: { readonly journal?: LiveListenerJournal },
  method: string,
  subject: unknown,
): LiveListenerActivity | undefined {
  try {
    const journal = observer.journal;
    if (typeof journal !== 'function') return undefined;
    const listener = listenerOf(method, subject);
    return listener === undefined ? undefined : journal(listener);
  } catch {
    // A listener the journal cannot open is still the SDK's own.
    return undefined;
  }
}

/** The SDK's unsubscribe, closing the listener's activity first. Any other result is passed back unchanged. */
export function closingUnsubscribe(activity: LiveListenerActivity, unsubscribe: unknown): unknown {
  if (typeof unsubscribe !== 'function') return unsubscribe;
  return function unsubscribed(this: unknown, ...values: unknown[]): unknown {
    try {
      activity.close();
    } catch {
      // The journal is a diagnostic; the SDK still unsubscribes.
    }
    return Reflect.apply(unsubscribe as Callback, this, values);
  };
}
