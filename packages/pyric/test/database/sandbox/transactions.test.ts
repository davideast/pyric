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

