import { expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getDatabase, ref, query, orderByChild, get, onValue, onChildAdded, sandbox as databaseSandbox } from 'pyric/database';
import { sdkActivity } from 'pyric/sandbox/internal';

test('missing indexes emit failed query operations without deliveries, then succeed after rules update', async () => {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox);
  databaseSandbox.setRules(db, { rules: { projects: { '.read': true } } });
  databaseSandbox.setData(db, { projects: { a: { budget: 5 } } });
  const source = query(ref(db, 'projects'), orderByChild('budget'));
  const events: string[] = [];
  const detach = sdkActivity.observe(event => { if (event.service === 'rtdb') events.push(event.phase); });
  try {
    await expect(get(source)).rejects.toThrow('Index not defined');
    expect(() => onValue(source, () => {})).toThrow('Index not defined');
    expect(() => onChildAdded(source, () => {})).toThrow('Index not defined');
    const failed = sandbox.history().filter(event => event.kind === 'operation' && event.service === 'rtdb' && event.result === 'error');
    expect(failed).toHaveLength(3);
    expect(failed.map(event => event.kind === 'operation' && event.method)).toEqual(['get', 'listen', 'listen']);
    expect(events).not.toContain('delivery');
    databaseSandbox.setRules(db, { rules: { projects: { '.read': true, '.indexOn': 'budget' } } });
    expect((await get(source)).exists()).toBe(true);
    expect(events).toContain('delivery');
    const stop = onValue(source, () => {});
    events.length = 0;
    stop();
    expect(events.filter(phase => phase !== 'remove')).toEqual(['end']);
  } finally { detach(); }
});
