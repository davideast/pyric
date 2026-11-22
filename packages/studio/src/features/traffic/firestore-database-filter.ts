/**
 * Pure Firestore database filtering and discovery helpers for Studio Traffic.
 */
import { DEFAULT_FIRESTORE_DATABASE } from 'pyric/firestore/internal';

export type FirestoreDatabaseFilter = 'all' | string;

function eventFirestoreDatabase(event: {
  service?: string;
  database?: string;
}): string | undefined {
  const isFirestore = event.service === undefined || event.service === 'firestore';
  if (!isFirestore) return undefined;
  if (
    typeof event.database === 'string' &&
    event.database.length > 0 &&
    event.database !== DEFAULT_FIRESTORE_DATABASE
  ) {
    return event.database;
  }
  return undefined;
}

/** Sorted non-default Firestore database ids present in `events`. */
export function observedFirestoreDatabases(
  events: readonly { service?: string; database?: string }[],
): string[] {
  const found = new Set<string>();
  for (const event of events) {
    const db = eventFirestoreDatabase(event);
    if (db !== undefined) found.add(db);
  }
  return [...found].sort();
}

/** Filter traffic events by Firestore database (`'all'` keeps every event across all services). */
export function filterByFirestoreDatabase<
  E extends { service?: string; database?: string },
>(events: readonly E[], filter: FirestoreDatabaseFilter): E[] {
  if (filter === 'all') return [...events];
  return events.filter((event) => {
    const isFirestore = event.service === undefined || event.service === 'firestore';
    if (!isFirestore) return false;
    const db = eventFirestoreDatabase(event) ?? DEFAULT_FIRESTORE_DATABASE;
    return db === filter;
  });
}
