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
import { firestoreJournalPlace } from './firestore.js';

export type { LiveListener, LiveListenerActivity } from '@pyric/cli/vite/internal/supplied-rows';

/** Opens one listener's activity. */
export type LiveListenerJournal = (listener: LiveListener) => LiveListenerActivity;

type Callback = (this: unknown, ...values: unknown[]) => unknown;

/**
 * The Firestore listener an export's arguments name: a reference or query,
 * or the snapshot JSON an `onSnapshotResume` resumes. Undefined for any
 * other subject.
 */
function firestoreListenerOf(method: string, args: readonly unknown[]): LiveListener | undefined {
  const place = firestoreJournalPlace(method, args);
  return place === undefined ? undefined : { method, ...place };
}

/** The Realtime Database listener a reference or query names, or undefined for any other subject. */
function databaseListenerOf(method: string, subject: unknown): LiveListener | undefined {
  const isObject = typeof subject === 'object' && subject !== null;
  const place = isObject ? databaseJournalPlace(subject) : undefined;
  return place === undefined ? undefined : { service: 'database', method, ...place };
}

/** The listener an export's arguments name, or undefined for any other subject. */
function listenerOf(method: string, args: readonly unknown[]): LiveListener | undefined {
  return firestoreListenerOf(method, args) ?? databaseListenerOf(method, args[0]);
}

/**
 * The listener's activity in the observer's journal, or undefined when the
 * observer has none, the arguments name no Firestore or database listener,
 * or opening it failed.
 */
export function openActivity(
  observer: { readonly journal?: LiveListenerJournal },
  method: string,
  args: readonly unknown[],
): LiveListenerActivity | undefined {
  try {
    const journal = observer.journal;
    if (typeof journal !== 'function') return undefined;
    const listener = listenerOf(method, args);
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
