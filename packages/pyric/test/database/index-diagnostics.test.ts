import { expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getDatabase, ref, query, orderByChild, get, onValue, onChildAdded, sandbox as databaseSandbox } from 'pyric/database';
import { sdkActivity } from 'pyric/sandbox/internal';

test('a missing index fails get() with a failed query operation, lets listeners deliver, then get() succeeds after a rules update', async () => {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox);
  databaseSandbox.setRules(db, { rules: { projects: { '.read': true } } });
  databaseSandbox.setData(db, { projects: { a: { budget: 5 } } });
  const source = query(ref(db, 'projects'), orderByChild('budget'));
  const events: string[] = [];
  const detach = sdkActivity.observe(event => { if (event.service === 'rtdb') events.push(event.phase); });
  try {
    await expect(get(source)).rejects.toThrow('Index not defined');
    const failed = sandbox.history().filter(event => event.kind === 'operation' && event.service === 'rtdb' && event.result === 'error');
    expect(failed.map(event => event.kind === 'operation' && [event.method, event.detail?.failure])).toEqual([['get', 'missing-index']]);
    expect(events).not.toContain('delivery');

    const values: unknown[] = [];
    const added: Array<string | null> = [];
    const stopValue = onValue(source, snap => { values.push(snap.val()); });
    const stopAdded = onChildAdded(source, snap => { added.push(snap.key); });
    stopValue();
    stopAdded();
    expect(values).toEqual([{ a: { budget: 5 } }]);
    expect(added).toEqual(['a']);
    const listens = sandbox.history().filter(event => event.kind === 'operation' && event.service === 'rtdb' && event.method === 'listen');
    expect(listens.map(event => event.kind === 'operation' && event.result)).toEqual(['allow', 'allow']);

    databaseSandbox.setRules(db, { rules: { projects: { '.read': true, '.indexOn': 'budget' } } });
    events.length = 0;
    expect((await get(source)).exists()).toBe(true);
    expect(events).toContain('delivery');
  } finally { detach(); }
});
