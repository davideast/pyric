import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  get,
  getAdminDatabase,
  getDatabase,
  increment,
  ref,
  runTransaction,
  sandbox,
  setWithPriority,
} from 'pyric/database';

describe('runTransaction on .read-denied, .write-allowed paths', () => {
  test('does not leak hidden server value or priority via increment() or blind overwrite', async () => {
    const box = initializeSandbox();
    const admin = getAdminDatabase(box);
    const callerDb = getDatabase(box.withAuth({ uid: 'u1' }));
    const ownerDb = getDatabase(box.withAuth({ uid: 'u2' }));

    await setWithPriority(ref(admin, 'users/u2/code'), 482910, 'prio-tag');
    await setWithPriority(ref(admin, 'users/u2/blind'), 918273, 'blind-prio');

    sandbox.setRules(callerDb, {
      rules: {
        users: {
          $uid: {
            code: {
              '.read': 'auth != null && auth.uid === $uid',
              '.write': 'auth != null',
            },
            blind: {
              '.read': 'auth != null && auth.uid === $uid',
              '.write': 'auth != null',
            },
          },
        },
      },
    });

    await expect(get(ref(callerDb, 'users/u2/code'))).rejects.toThrow('PERMISSION_DENIED');

    const incResult = await runTransaction(ref(callerDb, 'users/u2/code'), (current) => {
      expect(current).toBeNull();
      return increment(0);
    });
    expect(incResult.committed).toBe(true);
    expect(incResult.snapshot.val()).toBe(0);
    expect(incResult.snapshot.priority).toBeNull();
    expect(incResult.snapshot.exportVal()).toBe(0);

    // Server-side value and priority remain intact after a +0 increment.
    const serverCode = await get(ref(admin, 'users/u2/code'));
    expect(serverCode.val()).toBe(482910);
    expect(serverCode.priority).toBe('prio-tag');

    const blindResult = await runTransaction(ref(callerDb, 'users/u2/blind'), (current) => {
      expect(current).toBeNull();
      return 99;
    });
    expect(blindResult.committed).toBe(true);
    expect(blindResult.snapshot.val()).toBe(99);
    expect(blindResult.snapshot.priority).toBeNull();
    expect(blindResult.snapshot.exportVal()).toBe(99);

    // Inline priority explicitly supplied by a write-only caller is reflected on its own snapshot.
    const inlineResult = await runTransaction(ref(callerDb, 'users/u2/blind'), (current) => {
      expect(current).toBeNull();
      return { '.value': 77, '.priority': 'caller-prio' };
    });
    expect(inlineResult.committed).toBe(true);
    expect(inlineResult.snapshot.val()).toBe(77);
    expect(inlineResult.snapshot.priority).toBe('caller-prio');
    expect(inlineResult.snapshot.exportVal()).toEqual({ '.value': 77, '.priority': 'caller-prio' });

    // Readable owner transactions continue to resolve against stored value and preserve priority.
    await setWithPriority(ref(admin, 'users/u2/code'), 10, 'owner-prio');
    const ownerResult = await runTransaction(ref(ownerDb, 'users/u2/code'), (current) => {
      expect(current).toBe(10);
      return increment(5);
    });
    expect(ownerResult.committed).toBe(true);
    expect(ownerResult.snapshot.val()).toBe(15);
    expect(ownerResult.snapshot.priority).toBe('owner-prio');
  });
});
