import { expect, it } from 'bun:test';
import { BackendState } from '../../../src/database/sandbox/backend-state.js';
import { ChildListeners } from '../../../src/database/sandbox/child-listeners.js';
import { Transactions } from '../../../src/database/sandbox/transactions.js';
import { ValueListeners } from '../../../src/database/sandbox/value-listeners.js';

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
