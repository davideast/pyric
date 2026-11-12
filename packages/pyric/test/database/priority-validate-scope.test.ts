import { describe, expect, test } from 'bun:test';
import {
  get,
  getAdminDatabase,
  getDatabase,
  ref,
  sandbox as rtdbSandbox,
  setPriority,
  setWithPriority,
  update,
} from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';

const PRIORITY_AND_COUNTER_RULES = {
  rules: {
    orgs: {
      $orgId: {
        '.read': 'auth != null',
        '.write': 'auth != null',
        '.validate': 'newData.getPriority() === null || (newData.isNumber() === false && newData.getPriority() >= 0)',
        count: {
          '.validate': 'newData.isNumber() && newData.val() === data.val() + 1',
        },
        title: {
          '.validate': 'newData.isString()',
        },
      },
    },
  },
};

describe('RTDB .priority write validation scope', () => {
  test('setPriority and multi-path update with .priority validate ancestors and written siblings without walking untouched children', async () => {
    const sb = initializeSandbox();
    const adminDb = getAdminDatabase(sb);
    const userDb = getDatabase(sb.withAuth({ uid: 'u1', token: {} }));
    rtdbSandbox.setRules(userDb, PRIORITY_AND_COUNTER_RULES);
    rtdbSandbox.setData(adminDb, {
      'orgs/o1': { title: 'alpha', count: 5 },
    });

    await expect(setPriority(ref(userDb, 'orgs/o1'), 10)).resolves.toBeUndefined();
    expect((await get(ref(userDb, 'orgs/o1'))).priority).toBe(10);

    await expect(
      update(ref(userDb, 'orgs/o1'), { title: 'beta', '.priority': 20 }),
    ).resolves.toBeUndefined();
    const afterUpdate = await get(ref(userDb, 'orgs/o1'));
    expect(afterUpdate.val()).toEqual({ title: 'beta', count: 5 });
    expect(afterUpdate.priority).toBe(20);

    // Ancestor / owner .validate still rejects invalid priority values:
    await expect(setPriority(ref(userDb, 'orgs/o1'), -5)).rejects.toThrow(/PERMISSION_DENIED/);
    await expect(
      update(ref(userDb, 'orgs/o1'), { title: 'gamma', '.priority': -1 }),
    ).rejects.toThrow(/PERMISSION_DENIED/);

    // Full-node replacement via setWithPriority DOES rewrite children and therefore runs child .validate:
    await expect(
      setWithPriority(ref(userDb, 'orgs/o1'), { title: 'delta', count: 5 }, 30),
    ).rejects.toThrow(/PERMISSION_DENIED/);
    await expect(
      setWithPriority(ref(userDb, 'orgs/o1'), { title: 'delta', count: 6 }, 30),
    ).resolves.toBeUndefined();
  });
});
