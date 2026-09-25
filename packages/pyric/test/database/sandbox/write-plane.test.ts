import { expect, it } from 'bun:test';
import { BackendState } from '../../../src/database/sandbox/backend-state.js';
import { ChildListeners } from '../../../src/database/sandbox/child-listeners.js';
import { ValueListeners } from '../../../src/database/sandbox/value-listeners.js';
import { WritePlane } from '../../../src/database/sandbox/write-plane.js';

it('normalizes admin writes, resolves increments, and publishes snapshots', () => {
  const state = new BackendState();
  const writes = new WritePlane(state, new ValueListeners(state), new ChildListeners(state));
  writes.adminSet('/count', 2);
  writes.adminSet('/count', { '.sv': { increment: 3 } });
  expect(writes.adminGet('/count')).toBe(5);
  writes.adminUpdate('/items', { a: 1, b: 2 });
  expect(writes.snapshotState()).toEqual({ count: 5, items: { a: 1, b: 2 } });
});

it('cancels active non-admin value and child listeners with PERMISSION_DENIED when a mutation revokes data-dependent .read access while preserving adminOnValue', () => {
  const state = new BackendState();
  const values = new ValueListeners(state);
  const children = new ChildListeners(state);
  const writes = new WritePlane(state, values, children);

  writes.adminSet('/rooms/r1', {
    members: { alice: true },
    messages: { m1: 'welcome' },
  });
  writes.setRules({
    rules: {
      rooms: {
        $roomId: {
          '.read': "auth != null && data.child('members').child(auth.uid).val() == true",
          '.write': "auth != null && auth.uid == 'owner'",
        },
      },
    },
  });

  const aliceValueSnapshots: unknown[] = [];
  const aliceValueErrors: Error[] = [];
  const aliceChildAdded: string[] = [];
  const aliceChildErrors: Error[] = [];
  const adminSnapshots: unknown[] = [];

  values.onValue(
    { uid: 'alice' },
    '/rooms/r1/messages',
    (snap) => aliceValueSnapshots.push(snap.val),
    undefined,
    (err) => aliceValueErrors.push(err),
  );
  children.onChild(
    { uid: 'alice' },
    'child_added',
    '/rooms/r1/messages',
    (snap) => aliceChildAdded.push(snap.key),
    undefined,
    (err) => aliceChildErrors.push(err),
  );
  values.adminOnValue('/rooms/r1/messages', (snap) => adminSnapshots.push(snap.val));

  expect(aliceValueSnapshots).toEqual([{ m1: 'welcome' }]);
  expect(aliceChildAdded).toEqual(['m1']);
  expect(adminSnapshots).toEqual([{ m1: 'welcome' }]);

  // Mutate membership and add a secret message in one update: alice loses .read access
  writes.update({ uid: 'owner' }, '/rooms/r1', {
    'members/alice': null,
    'messages/m2': 'top-secret',
  });

  // Alice's value and child listeners must be canceled with PERMISSION_DENIED and must NOT receive m2
  expect(aliceValueErrors).toHaveLength(1);
  expect((aliceValueErrors[0] as Error & { code?: string }).code).toBe('PERMISSION_DENIED');
  expect(aliceValueSnapshots).toEqual([{ m1: 'welcome' }]);

  expect(aliceChildErrors).toHaveLength(1);
  expect((aliceChildErrors[0] as Error & { code?: string }).code).toBe('PERMISSION_DENIED');
  expect(aliceChildAdded).toEqual(['m1']);

  // Admin listener is exempt and receives the updated snapshot
  expect(adminSnapshots).toEqual([
    { m1: 'welcome' },
    { m1: 'welcome', m2: 'top-secret' },
  ]);
});

it('passes querySpec when re-evaluating query-gated value and child listeners on mutations', () => {
  const state = new BackendState();
  const values = new ValueListeners(state);
  const children = new ChildListeners(state);
  const writes = new WritePlane(state, values, children);

  writes.adminSet('/scores', { a: 10, b: 20 });
  writes.setRules({
    rules: {
      scores: {
        '.read': 'query.orderByValue && query.limitToFirst <= 5',
        '.write': true,
        '.indexOn': '.value',
      },
    },
  });

  const querySpec = {
    orderBy: { kind: 'value' as const },
    bounds: [],
    limit: { kind: 'limitToFirst' as const, n: 2 },
  };
  const valueErrors: Error[] = [];
  const childErrors: Error[] = [];
  const valueSnaps: unknown[] = [];

  values.onValue(
    { uid: 'alice' },
    '/scores',
    (snap) => valueSnaps.push(snap.val),
    querySpec,
    (err) => valueErrors.push(err),
  );
  children.onChild(
    { uid: 'alice' },
    'child_added',
    '/scores',
    () => {},
    querySpec,
    (err) => childErrors.push(err),
  );

  writes.set({ uid: 'alice' }, '/scores/a', 5);

  expect(valueErrors).toEqual([]);
  expect(childErrors).toEqual([]);
  expect(valueSnaps).toEqual([
    { a: 10, b: 20 },
    { a: 5, b: 20 },
  ]);
});

