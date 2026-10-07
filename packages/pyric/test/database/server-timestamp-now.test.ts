/**
 * A write's server timestamp and the rules' `now` are the same instant, as in
 * production, where `newData.val() == now` is the documented check that a
 * client wrote `serverTimestamp()`. The sandbox clock here advances on every
 * read, so a write that read the clock twice would see two instants.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getDatabase, onDisconnect, ref, runTransaction, sandbox, serverTimestamp, set, update } from 'pyric/database';

const realNow = Date.now;
let tick = 0;

beforeEach(() => {
  tick = realNow();
  Date.now = () => ++tick;
});
afterEach(() => {
  Date.now = realNow;
});

const rules = {
  rules: {
    stamps: { $id: { '.write': 'auth != null', '.validate': 'newData.val() == now' } },
    records: { $id: { '.write': 'auth != null', at: { '.validate': 'newData.val() == now' } } },
  },
};

function client() {
  const box = initializeSandbox();
  sandbox.setRules(getDatabase(box.withAuth({ uid: 'admin' })), rules);
  return getDatabase(box.withAuth({ uid: 'alice' }));
}

describe('server timestamp equals now in the rules', () => {
  test('set', async () => {
    await set(ref(client(), 'stamps/a'), serverTimestamp());
  });

  test('update', async () => {
    await update(ref(client(), 'records/r1'), { at: serverTimestamp() });
  });

  test('multi-path update', async () => {
    await update(ref(client(), '/'), { 'stamps/a': serverTimestamp(), 'records/r1/at': serverTimestamp() });
  });

  test('onDisconnect registration', async () => {
    await onDisconnect(ref(client(), 'stamps/a')).set(serverTimestamp());
  });

  test('transaction', async () => {
    const result = await runTransaction(ref(client(), 'stamps/a'), () => serverTimestamp());
    expect(result.committed).toBe(true);
  });
});
