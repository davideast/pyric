import { describe, expect, it } from 'bun:test';
import {
  collection,
  collectionGroup,
  getDocs,
  getFirestore,
  onSnapshot,
  or,
  query,
  where,
} from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';

describe('query activity projection', () => {
  it('retains distinct operand identities in real listener lifecycle events', () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));

    const unsubscribes = [
      onSnapshot(query(collection(db, 'users'), where('status', '==', 'open')), () => {}),
      onSnapshot(query(collection(db, 'users'), where('status', '==', 'closed')), () => {}),
    ];

    expect(sandbox.history().filter((event) => event.kind === 'listener_attach').map(
      (event) => event.target,
    )).toEqual([
      {
        kind: 'query',
        collection: 'users',
        query: {
          scope: { kind: 'collection' },
          filters: [{
            kind: 'where',
            field: 'status',
            op: '==',
            value: { type: 'string-digest', length: 4, digest: expect.any(String) },
          }],
          orderBy: [],
          limit: null,
          limitFromEnd: false,
          start: null,
          end: null,
        },
      },
      {
        kind: 'query',
        collection: 'users',
        query: {
          scope: { kind: 'collection' },
          filters: [{
            kind: 'where',
            field: 'status',
            op: '==',
            value: { type: 'string-digest', length: 6, digest: expect.any(String) },
          }],
          orderBy: [],
          limit: null,
          limitFromEnd: false,
          start: null,
          end: null,
        },
      },
    ]);

    for (const unsubscribe of unsubscribes) unsubscribe();
  });

  it('projects distinct composite filters without collapsing them', () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    const unsubscribes = [
      onSnapshot(query(
        collection(db, 'users'),
        or(where('status', '==', 'open'), where('owner', '==', 'alice')),
      ), () => {}),
      onSnapshot(query(
        collection(db, 'users'),
        or(where('status', '==', 'closed'), where('owner', '==', 'bob')),
      ), () => {}),
    ];

    const targets = sandbox.history()
      .filter((event) => event.kind === 'listener_attach')
      .map((event) => JSON.stringify(event.target));
    expect(targets[0]).not.toBe(targets[1]);

    for (const unsubscribe of unsubscribes) unsubscribe();
  });

  it('projects collection and collection-group reads with distinct scopes', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, `rules_version = '2'; service cloud.firestore {
      match /databases/{database}/documents { match /{document=**} { allow read: if true; } }
    }`);
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));

    await getDocs(collection(db, 'items'));
    await getDocs(collectionGroup(db, 'items'));

    const queries = sandbox.history()
      .filter((event) => event.kind === 'request' && event.method === 'list')
      .map((event) => JSON.stringify(event.detail?.activityQuery));
    expect(queries).toHaveLength(2);
    expect(queries[0]).not.toBe(queries[1]);
    expect(queries[0]).toContain('collection');
    expect(queries[1]).toContain('collection-group');
  });

  it('uses identity for untrusted arrays while retaining reuse', () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    const reused = ['open', 'pending'];
    const operands = [reused, reused, ['open', 'pending'], ['open', 'pending']];
    const unsubscribes = operands.map((operand) => onSnapshot(
      query(collection(db, 'users'), where('status', 'in', operand)),
      () => {},
    ));

    const targets = sandbox.history()
      .filter((event) => event.kind === 'listener_attach')
      .map((event) => JSON.stringify(event.target));
    expect(targets[0]).toBe(targets[1]);
    expect(new Set(targets)).toHaveLength(3);

    for (const unsubscribe of unsubscribes) unsubscribe();
  });
});
