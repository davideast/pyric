/**
 * Where a wrapped Firestore or Realtime Database listener sits in the page's
 * SDK activity journal.
 * The listener wrapper (`observe.ts`) reads the listener's target and key off
 * the reference or query the app passed, opens its activity through the
 * observer's `journal` (`@pyric/cli`'s `journalLiveListener` on a page), and
 * closes it when the app unsubscribes. Nothing here calls the app's own code,
 * and a failure here leaves the listener the SDK's own.
 *
 * Loaded in the page too, so it imports only types from `@pyric/cli`.
 */
import type { LiveListener, LiveListenerActivity } from '@pyric/cli/vite/internal/supplied-rows';
import { databaseJournalPlace } from './database.js';
import { firestorePath } from './firestore.js';

export type { LiveListener, LiveListenerActivity } from '@pyric/cli/vite/internal/supplied-rows';

/** Opens one listener's activity. */
export type LiveListenerJournal = (listener: LiveListener) => LiveListenerActivity;

type Callback = (this: unknown, ...values: unknown[]) => unknown;

/** The Firestore listener a reference or query names, or undefined for any other subject. */
function firestoreListenerOf(method: string, subject: object): LiveListener | undefined {
  const firestore: unknown = Reflect.get(subject, 'firestore');
  const hasFirestore = typeof firestore === 'object' && firestore !== null;
  if (!hasFirestore) return undefined;
  const type: unknown = Reflect.get(subject, 'type');
  const path = firestorePath(subject, type);
  if (path === undefined) return undefined;
  return { firestore, method, isQuery: type !== 'document', ...path };
}

/** The Realtime Database listener a reference or query names, or undefined for any other subject. */
function databaseListenerOf(method: string, subject: object): LiveListener | undefined {
  const place = databaseJournalPlace(subject);
  return place === undefined ? undefined : { service: 'database', method, ...place };
}

/** The listener an export's first argument names, or undefined for any other subject. */
function listenerOf(method: string, subject: unknown): LiveListener | undefined {
  const isObject = typeof subject === 'object' && subject !== null;
  if (!isObject) return undefined;
  return firestoreListenerOf(method, subject) ?? databaseListenerOf(method, subject);
}

/**
 * The listener's activity in the observer's journal, or undefined when the
 * observer has none, the subject is no Firestore or database reference or query, or
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
