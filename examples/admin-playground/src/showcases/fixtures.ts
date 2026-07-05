import { initializeSandbox } from 'pyric/sandbox';
import {
  Bytes,
  GeoPoint,
  Timestamp,
  collection as collFn,
  doc as docFn,
  getFirestore,
  type CollectionReference,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  type QueryDocumentSnapshot,
} from 'pyric/firestore';

/**
 * Shared sandbox + Firestore handle for every showcase that needs
 * real `@pyric/firestore` ref objects. Initialize once per module
 * load — the showcase canvas mounts a single React tree, no
 * multi-init concern.
 */
export const sandbox = initializeSandbox();
export const firestore: Firestore = getFirestore(sandbox.withAuth({ uid: 'showcase' }));

export function makeRef(path: string): DocumentReference {
  return docFn(firestore, path);
}

export function makeColl(path: string): CollectionReference {
  return collFn(firestore, path);
}

/**
 * Build a minimal stand-in `DocumentSnapshot`. The library's
 * read-side components only touch `id`, `exists`, and `data()` —
 * we don't bother stubbing the rest. Editor/preview components
 * never reach for `.ref`.
 */
export function makeSnapshot(
  id: string,
  data: Record<string, unknown> | null,
): DocumentSnapshot {
  return {
    id,
    exists: () => data !== null,
    data: () => data ?? undefined,
  } as unknown as DocumentSnapshot;
}

/** Same as `makeSnapshot` but the resulting object also carries a
 *  `ref` field so `<DocumentList>` (which reaches for `.ref`) can
 *  render rows. */
export function makeQuerySnapshot(
  parent: CollectionReference,
  id: string,
  data: Record<string, unknown>,
): QueryDocumentSnapshot {
  return {
    id,
    ref: docFn(parent, id),
    exists: true,
    data: () => data,
  } as unknown as QueryDocumentSnapshot;
}

/** Fixture user-document shape exercising every supported field type. */
export const RICH_USER = {
  name: 'Alice Hu',
  email: 'alice@example.com',
  score: 1287,
  active: true,
  pendingReview: null,
  joinedAt: Timestamp.fromDate(new Date('2024-08-12T16:21:09Z')),
  lastLocation: new GeoPoint(37.7749, -122.4194),
  manager: makeRef('users/bob'),
  avatar: Bytes.fromBase64String('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='),
  tags: ['admin', 'beta', 'pro'],
  preferences: {
    theme: 'dark',
    density: 'comfortable',
    notifications: {
      email: true,
      push: false,
    },
  },
  recentSessions: [
    { device: 'macbook', lastActive: Timestamp.fromDate(new Date('2025-04-12T09:14:00Z')) },
    { device: 'iphone', lastActive: Timestamp.fromDate(new Date('2025-04-11T22:03:11Z')) },
  ],
};

export const FIXTURE_COLLECTIONS = [
  makeColl('users'),
  makeColl('posts'),
  makeColl('orders'),
  makeColl('feature_flags'),
];

export const FIXTURE_USERS = (() => {
  const users = makeColl('users');
  return [
    makeQuerySnapshot(users, 'alice', { name: 'Alice Hu', score: 1287, active: true }),
    makeQuerySnapshot(users, 'bob', { name: 'Bob Smith', score: 412, active: true }),
    makeQuerySnapshot(users, 'carol', { name: 'Carol Lin', score: 833, active: false }),
    makeQuerySnapshot(users, 'dave', { name: 'Dave Park', score: 219, active: true }),
    makeQuerySnapshot(users, 'eve', { name: 'Eve Walker', score: 991, active: true }),
  ];
})();
