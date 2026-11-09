import { describe, expect, test } from 'bun:test';
import { getClock, initializeSandbox } from 'pyric/sandbox';
import {
  get,
  getAdminDatabase,
  getDatabase,
  onChildAdded,
  onValue,
  ref,
  sandbox,
  set,
} from 'pyric/database';

describe('RTDB time-bounded .read rules revoke expired listeners before fan-out', () => {
  test('cancels onValue and onChildAdded listeners when now advances past a .read deadline', async () => {
    const box = initializeSandbox();
    getClock(box).set(1_700_000_000_000);
    const db = getDatabase(box.withAuth({ uid: 'u1' }));
    const admin = getAdminDatabase(box);

    await set(ref(admin, 'items/i1'), { title: 'initial' });
    sandbox.setRules(db, {
      rules: {
        items: {
          '.read': 'auth != null && now < 1700000005000',
        },
      },
    });

    const valueDeliveries: unknown[] = [];
    const childKeys: Array<string | null> = [];
    const cancelledCodes: string[] = [];

    const unsubValue = onValue(
      ref(db, 'items'),
      (snap) => valueDeliveries.push(snap.val()),
      (err) => cancelledCodes.push((err as Error & { code: string }).code),
    );
    const unsubChild = onChildAdded(
      ref(db, 'items'),
      (snap) => childKeys.push(snap.key),
      (err) => cancelledCodes.push((err as Error & { code: string }).code),
    );

    expect(valueDeliveries).toEqual([{ i1: { title: 'initial' } }]);
    expect(childKeys).toEqual(['i1']);

    getClock(box).set(1_700_000_010_000);
    await expect(get(ref(db, 'items'))).rejects.toThrow('PERMISSION_DENIED');

    await set(ref(admin, 'items/i2'), { title: 'after-deadline' });

    unsubValue();
    unsubChild();

    expect(cancelledCodes).toEqual(['PERMISSION_DENIED', 'PERMISSION_DENIED']);
    expect(valueDeliveries).toEqual([{ i1: { title: 'initial' } }]);
    expect(childKeys).toEqual(['i1']);
  });
});
