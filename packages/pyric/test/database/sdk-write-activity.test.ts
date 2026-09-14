import { expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getDatabase, ref, set, update, remove, push, setPriority, setWithPriority, runTransaction, onValue, sandbox as databaseSandbox } from '../../src/database/index.js';
import { sdkActivity, type SdkActivityEvent } from '../../src/sandbox/internal/sdk-activity.js';

it('records one RTDB public call for multipath updates and pushes, denied attempts and independent listener updates', async () => {
  const db = getDatabase(initializeSandbox());
  databaseSandbox.setDefaultPolicy(db, 'allow');
  const target = ref(db, 'notes');
  const events: SdkActivityEvent[] = [];
  const stop = sdkActivity.subscribe(event => events.push(event));
  const unsubscribe = onValue(target, () => {});
  try {
    await set(target, { one: 1 });
    await update(target, { 'one/a': 2, 'two/b': 3 });
    await setPriority(target, 1);
    await setWithPriority(target, { count: 4 }, 2);
    await push(target, { count: 5 });
    await push(target); // creating a reference is not a data operation
    await remove(target);
    await runTransaction(target, () => ({ count: 6 }));
    await runTransaction(target, () => undefined);
    unsubscribe();
    databaseSandbox.setDefaultPolicy(db, 'deny');
    await expect(set(target, { denied: true })).rejects.toBeDefined();
    expect(events.filter(event => event.phase === 'start').map(event => event.record.method)).toEqual([
      'onValue', 'set', 'update', 'setPriority', 'setWithPriority', 'push', 'remove', 'runTransaction', 'runTransaction', 'set',
    ]);
    expect(events.filter(event => event.phase === 'delivery' && event.record.kind === 'operation')).toHaveLength(0);
    expect(events.filter(event => event.phase === 'delivery' && event.record.kind === 'subscription').length).toBeGreaterThan(1);
    expect(events.at(-1)?.record.status).toBe('failed');
  } finally { unsubscribe(); stop(); }
});

it('counts a retried RTDB transaction once, without counting internal reads or writes', async () => {
  const db = getDatabase(initializeSandbox());
  databaseSandbox.setDefaultPolicy(db, 'allow');
  const target = ref(db, 'counter');
  await set(target, 1);
  const events: SdkActivityEvent[] = [];
  const stop = sdkActivity.subscribe(event => events.push(event));
  let attempts = 0;
  try {
    await runTransaction<number>(target, value => {
      if (++attempts === 1) void set(target, 10);
      return (value ?? 0) + 1;
    });
    expect(attempts).toBe(2);
    expect(events.filter(event => event.phase === 'start').map(event => event.record.method)).toEqual(['runTransaction', 'set']);
    expect(events.filter(event => event.phase === 'delivery')).toHaveLength(0);
  } finally { stop(); }
});
