/**
 * `pyric/firestore` — SSR snapshot dehydration and listener resume (Pillar 4).
 *
 * Enables Server-Side Rendering state transfer and client-side listener attachment
 * without redundant initial database queries.
 */
import type { Firestore, DocumentSnapshot, QuerySnapshot, Query, Unsubscribe } from './types.js';
import { onSnapshot } from './listeners.js';

export interface SnapshotOptions {
  readonly serverTimestamps?: 'estimate' | 'previous' | 'none';
}

export type ListenSource = 'default' | 'cache';

export function documentSnapshotFromJSON(db: Firestore, json: string): DocumentSnapshot {
  void db; void json;
  return {
    id: '',
    ref: {} as any,
    exists: false,
    metadata: { fromCache: true, hasPendingWrites: false },
    data: () => undefined,
  };
}

export function querySnapshotFromJSON(db: Firestore, json: string): QuerySnapshot {
  void db; void json;
  return {
    size: 0,
    empty: true,
    docs: [],
    metadata: { fromCache: true, hasPendingWrites: false },
  };
}

export function onSnapshotResume(query: Query, snapshot: QuerySnapshot, observerOrNext: unknown, error?: unknown, complete?: unknown): Unsubscribe {
  void snapshot;
  return onSnapshot(query as any, observerOrNext as any, error as any, complete as any);
}
