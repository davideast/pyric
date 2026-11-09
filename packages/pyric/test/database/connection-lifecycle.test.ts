import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  get,
  getAdminDatabase,
  getDatabase,
  goOffline,
  onDisconnect,
  ref,
  sandbox,
  set,
} from 'pyric/database';

describe('onDisconnect descendant cancel atomic priority and merge semantics', () => {
  test('commits data and root .priority atomically when .validate checks newData.getPriority()', async () => {
    const box = initializeSandbox();
    const db = getDatabase(box.withAuth({ uid: 'u1' }));
    const admin = getAdminDatabase(box);
    sandbox.setRules(db, {
      rules: {
        items: {
          $id: {
            '.read': true,
            '.write': 'auth != null',
            '.validate': "newData.hasChildren(['keep']) && newData.getPriority() === 10",
          },
        },
      },
    });

    await onDisconnect(ref(db, 'items/i1')).setWithPriority({ keep: 'yes', drop: 'no' }, 10);
    await onDisconnect(ref(db, 'items/i1/drop')).cancel();
    goOffline(db);

    const snap = await get(ref(admin, 'items/i1'));
    expect(snap.val()).toEqual({ keep: 'yes' });
    expect(snap.priority).toBe(10);
  });

  test('rolls back data atomically when .validate rejects the merged priority at disconnect', async () => {
    const box = initializeSandbox();
    const db = getDatabase(box.withAuth({ uid: 'u1' }));
    const admin = getAdminDatabase(box);
    sandbox.setRules(db, {
      rules: {
        items: {
          $id: {
            '.read': true,
            '.write': 'auth != null',
          },
        },
      },
    });

    await onDisconnect(ref(db, 'items/i1')).setWithPriority({ keep: 'blocked', drop: 'no' }, 10);
    await onDisconnect(ref(db, 'items/i1/drop')).cancel();

    sandbox.setRules(db, {
      rules: {
        items: {
          $id: {
            '.read': true,
            '.write': 'auth != null',
            '.validate': 'newData.getPriority() === null',
          },
        },
      },
    });

    goOffline(db);
    const snap = await get(ref(admin, 'items/i1'));
    expect(snap.val()).toBeNull();
    expect(snap.priority).toBeNull();
  });

  test('preserves nested ancestor .priority metadata when unfolding around a cancelled grandchild', async () => {
    const box = initializeSandbox();
    const db = getDatabase(box.withAuth({ uid: 'u1' }));
    const admin = getAdminDatabase(box);
    sandbox.setRules(db, {
      rules: { '.read': true, '.write': 'auth != null' },
    });

    await onDisconnect(ref(db, 'items/i1')).set({
      keep: { stay: 'v1', drop: 'no', '.priority': 77 },
    });
    await onDisconnect(ref(db, 'items/i1/keep/drop')).cancel();
    goOffline(db);

    const keepSnap = await get(ref(admin, 'items/i1/keep'));
    expect(keepSnap.val()).toEqual({ stay: 'v1' });
    expect(keepSnap.priority).toBe(77);
  });

  test('does not apply ghost priority when cancelling all children of a queued setWithPriority', async () => {
    const box = initializeSandbox();
    const db = getDatabase(box.withAuth({ uid: 'u1' }));
    const admin = getAdminDatabase(box);
    await set(ref(admin, 'items/i1'), { existing: 'stay' });
    await set(ref(admin, 'items/i2'), { existing: 'stay' });
    sandbox.setRules(db, {
      rules: { '.read': true, '.write': 'auth != null' },
    });

    await onDisconnect(ref(db, 'items/i1')).setWithPriority({ onlyChild: 'gone' }, 99);
    await onDisconnect(ref(db, 'items/i1/onlyChild')).cancel();

    await onDisconnect(ref(db, 'items/i2')).setWithPriority({ first: 'gone', second: 'gone' }, 88);
    await onDisconnect(ref(db, 'items/i2/first')).cancel();
    await onDisconnect(ref(db, 'items/i2/second')).cancel();

    goOffline(db);

    const snap1 = await get(ref(admin, 'items/i1'));
    expect(snap1.val()).toEqual({ existing: 'stay' });
    expect(snap1.priority).toBeNull();

    const snap2 = await get(ref(admin, 'items/i2'));
    expect(snap2.val()).toEqual({ existing: 'stay' });
    expect(snap2.priority).toBeNull();
  });
});
