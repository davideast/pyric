import { describe, expect, test } from 'bun:test';
import { get, getDatabase, ref, set } from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getActiveRules,
  setData,
  setDefaultPolicy,
  setRules,
  snapshotState,
} from 'pyric/sandbox/database';

describe('pyric/sandbox/database', () => {
  test('owner controls and the database mirror share one sandbox state', async () => {
    const sandbox = initializeSandbox();
    setDefaultPolicy(sandbox, 'allow');

    setData(sandbox, {
      '/notes/n1': { title: 'Local only' },
    });

    expect(snapshotState(sandbox)).toEqual({
      notes: { n1: { title: 'Local only' } },
    });

    const note = await get(ref(getDatabase(sandbox), '/notes/n1'));
    expect(note.val()).toEqual({ title: 'Local only' });
  });

  test('replacing active rules changes the next mirrored operation', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
    const rules = { rules: { '.read': false } };

    setRules(sandbox, rules);
    expect(getActiveRules(sandbox)).toEqual(rules);
    await expect(get(ref(db, '/notes/n1'))).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });

    setRules(sandbox, { rules: { '.read': true } });
    await expect(get(ref(db, '/notes/n1'))).resolves.toBeDefined();
  });

  test('per-user rules written with === and !== allow the owner and deny everyone else', async () => {
    const sandbox = initializeSandbox();
    const rule = '$uid !== "nobody" && $uid === auth.uid';
    setRules(sandbox, { rules: { users: { $uid: { '.read': rule, '.write': rule } } } });

    const alice = getDatabase(sandbox.withAuth({ uid: 'alice' }));
    await set(ref(alice, '/users/alice'), { name: 'Alice' });
    expect((await get(ref(alice, '/users/alice'))).val()).toEqual({ name: 'Alice' });
    await expect(set(ref(alice, '/users/bob'), { name: 'Bob' })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });

    const nobody = getDatabase(sandbox.withAuth({ uid: 'nobody' }));
    await expect(set(ref(nobody, '/users/nobody'), { name: 'Nobody' })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });
});
