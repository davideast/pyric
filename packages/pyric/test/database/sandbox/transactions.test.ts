import { expect, it } from 'bun:test';
import { BackendState } from '../../../src/database/sandbox/backend-state.js';
import { ChildListeners } from '../../../src/database/sandbox/child-listeners.js';
import { Transactions } from '../../../src/database/sandbox/transactions.js';
import { ValueListeners } from '../../../src/database/sandbox/value-listeners.js';
import { WritePlane } from '../../../src/database/sandbox/write-plane.js';

it('retries an overlapping re-entrant write and releases mutation history', () => {
  const state = new BackendState();
  state.rules.setDefaultPolicy('allow');
  const values = new ValueListeners(state);
  const children = new ChildListeners(state);
  const transactions = new Transactions(state, values, children);
  state.tree.write('/count', 0);
  const seen: unknown[] = [];
  let injected = false;
  const result = transactions.run(null, '/count', (current) => {
    seen.push(current);
    if (!injected) {
      injected = true;
      state.tree.write('/count', 10);
      state.mutations.mark('/count');
    }
    return ((current as number | null) ?? 0) + 1;
  });
  expect(seen).toEqual([0, 10]);
  expect(result).toEqual({ committed: true, val: 11, key: 'count' });
  expect(state.mutations.entries).toHaveLength(0);
});

it('never broadcasts speculative updates to active listeners when security rules reject a transaction', () => {
  const state = new BackendState();
  state.rules.setRules({
    rules: {
      counter: {
        '.read': true,
        '.write': "auth != null && auth.uid == 'admin'",
      },
    },
  });
  const values = new ValueListeners(state);
  const children = new ChildListeners(state);
  const transactions = new Transactions(state, values, children);

  state.tree.write('/counter', 10);

  const observedValues: unknown[] = [];
  const unsub = values.onValue({ uid: 'admin' }, '/counter', (snap) => {
    observedValues.push(snap.val());
  });
  observedValues.length = 0;

  expect(() => {
    transactions.run({ uid: 'intruder' }, '/counter', (curr) => ((curr as number | null) ?? 0) + 999);
  }).toThrow('permission_denied');

  unsub();
  expect(observedValues).toEqual([]);
});

it('marks a locally applied transaction commit so an enclosing transaction detects the conflict', () => {
  const state = new BackendState();
  state.rules.setDefaultPolicy('allow');
  const values = new ValueListeners(state);
  const children = new ChildListeners(state);
  const transactions = new Transactions(state, values, children);
  state.tree.write('/count', 0);
  const seen: unknown[] = [];
  let nested = false;
  const result = transactions.run(null, '/count', (current) => {
    seen.push(current);
    if (!nested) {
      nested = true;
      transactions.run(null, '/count', () => 10, { applyLocally: true });
    }
    return ((current as number | null) ?? 0) + 1;
  });
  expect(seen).toEqual([0, 10]);
  expect(result).toEqual({ committed: true, val: 11, key: 'count' });
});


it('clears node priority when a transaction deletes a node by returning null', () => {
  const state = new BackendState();
  state.rules.setDefaultPolicy('allow');
  const values = new ValueListeners(state);
  const children = new ChildListeners(state);
  const transactions = new Transactions(state, values, children);

  state.tree.write('/item', 'hello');
  state.priorities.replace('/item', 42);
  expect(transactions.run(null, '/item', () => null)).toMatchObject({ committed: true, val: null });
  expect(state.priorities.get('/item')).toBeNull();

  state.tree.write('/item2', 'world');
  state.priorities.replace('/item2', 99);
  expect(transactions.run(null, '/item2', () => null, { applyLocally: false })).toMatchObject({ committed: true });
  expect(state.priorities.get('/item2')).toBeNull();
});

it('redacts the current value to null when .read is denied on both abort and write attempts', () => {
  const state = new BackendState();
  state.rules.setRules({
    rules: {
      vault: {
        '.read': false,
        '.write': false,
      },
      inbox: {
        count: {
          '.read': false,
          '.write': true,
        },
      },
    },
  });
  const values = new ValueListeners(state);
  const children = new ChildListeners(state);
  const transactions = new Transactions(state, values, children);

  state.tree.write('/vault', { secret: 'classified', balance: 5000 });
  state.tree.write('/inbox/count', 10);

  const seenOnAbort: unknown[] = [];
  const aborted = transactions.run({ uid: 'alice' }, '/vault', (current) => {
    seenOnAbort.push(current);
    return undefined;
  });
  expect(seenOnAbort).toEqual([null]);
  expect(aborted).toEqual({ committed: false, val: null, key: 'vault' });
  expect(state.tree.read('/vault')).toEqual({ secret: 'classified', balance: 5000 });

  const seenOnDeny: unknown[] = [];
  expect(() => {
    transactions.run({ uid: 'alice' }, '/vault', (current) => {
      seenOnDeny.push(current);
      return { secret: 'overwritten', balance: 0 };
    });
  }).toThrow('permission_denied');
  expect(seenOnDeny).toEqual([null]);
  expect(state.tree.read('/vault')).toEqual({ secret: 'classified', balance: 5000 });

  const seenOnWriteOnly: unknown[] = [];
  const committed = transactions.run({ uid: 'alice' }, '/inbox/count', (current) => {
    seenOnWriteOnly.push(current);
    return { '.sv': { increment: 5 } };
  });
  expect(seenOnWriteOnly).toEqual([null]);
  expect(committed).toEqual({ committed: true, val: 15, key: 'count' });
  expect(state.tree.read('/inbox/count')).toBe(15);
});

it('bypasses read and write rules when admin option is true and preserves priority on newData (#1014)', () => {
  const state = new BackendState();
  state.rules.setRules({
    rules: {
      vault: { '.read': false, '.write': false },
      prioritized: { '.read': true, '.write': 'newData.getPriority() === 7' },
    },
  });
  const values = new ValueListeners(state);
  const children = new ChildListeners(state);
  const transactions = new Transactions(state, values, children);

  state.tree.write('/vault', 40);
  const seenAdmin: unknown[] = [];
  const adminOut = transactions.run(null, '/vault', (current) => {
    seenAdmin.push(current);
    return ((current as number | null) ?? 0) + 2;
  }, { admin: true });
  expect(seenAdmin).toEqual([40]);
  expect(adminOut).toEqual({ committed: true, val: 42, key: 'vault' });

  state.tree.write('/prioritized', 1);
  state.priorities.replace('/prioritized', 7);
  const prioOut = transactions.run({ uid: 'u1' }, '/prioritized', (current) => ((current as number | null) ?? 0) + 1);
  expect(prioOut).toEqual({ committed: true, val: 2, key: 'prioritized' });
  expect(state.priorities.get('/prioritized')).toBe(7);
});

// DF-1 (#1247): a transaction commit is a data write, so it revokes listeners
// through the same path a set or update takes, before anything is delivered.
for (const applyLocally of [true, false]) {
  it(`revokes the listeners a commit denies before delivering to them (applyLocally ${applyLocally})`, () => {
    const state = new BackendState();
    const values = new ValueListeners(state);
    const children = new ChildListeners(state);
    const writes = new WritePlane(state, values, children);
    const transactions = new Transactions(state, values, children);
    writes.setRules({
      rules: { rooms: { $room: { '.read': "data.child('members').child(auth.uid).val() == true", '.write': true } } },
    });
    writes.adminSet('/rooms/r1', { members: { alice: true }, msg: 'hi' });
    const delivered: unknown[] = [];
    const cancelled: string[] = [];
    const childCancelled: string[] = [];
    values.onValue({ uid: 'alice' }, '/rooms/r1', (snap) => delivered.push(snap.val()), undefined,
      (err) => cancelled.push((err as Error & { code: string }).code));
    children.onChild({ uid: 'alice' }, 'child_added', '/rooms/r1/messages', () => {}, undefined,
      (err) => childCancelled.push((err as Error & { code: string }).code));
    delivered.length = 0;
    const recorded: string[] = [];
    const operation = state.events.operation.bind(state.events);
    state.events.operation = (auth, method, path, result, evaluation, fields) => {
      recorded.push(`${method} ${path} ${result}`);
      operation(auth, method, path, result, evaluation, fields);
    };
    const commit = state.events.commit.bind(state.events);
    state.events.commit = (auth, method, path, fields) => {
      recorded.push(`commit ${method} ${path}`);
      commit(auth, method, path, fields);
    };

    transactions.run({ uid: 'alice' }, '/rooms/r1/members/alice', () => false, { applyLocally });

    expect({ delivered, cancelled, childCancelled }).toEqual({
      delivered: [], cancelled: ['PERMISSION_DENIED'], childCancelled: ['PERMISSION_DENIED'],
    });
    // Recorded as a set is: the operation, the revocations it causes, then the commit.
    expect(recorded).toEqual([
      'transaction /rooms/r1/members/alice allow',
      'listen /rooms/r1 deny',
      'listen /rooms/r1/messages deny',
      'commit transaction /rooms/r1/members/alice',
    ]);
  });
}
