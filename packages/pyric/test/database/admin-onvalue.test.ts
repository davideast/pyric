/**
 * #401 — Cloud Functions RTDB triggers read via firebase-admin, which bypasses
 * security rules. The sandbox relays that trigger subscription through the
 * `getAdminDatabase` (rules-bypass) handle. These tests lock the listen-plane
 * bypass — the sibling of `adminGet`/`adminSet` — and the invariant that the
 * ordinary (page) `onValue` stays rule-gated.
 */
import { describe, expect, test } from 'bun:test';
import { getAdminDatabase, getDatabase, onValue, ref, set } from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';
import { setData, setRules } from 'pyric/sandbox/database';

const AUTH_GATED = {
  rules: {
    status: {
      $uid: {
        '.read': 'auth != null',
        '.write': 'auth != null',
      },
    },
  },
};

describe('admin onValue bypasses read rules (#401)', () => {
  test('an admin listener on an auth-gated path fires and keeps streaming', async () => {
    const sandbox = initializeSandbox();
    setData(sandbox, { '/status/alice': { online: false } });
    setRules(sandbox, AUTH_GATED);

    const adminDb = getAdminDatabase(sandbox);
    const seen: unknown[] = [];
    const unsub = onValue(ref(adminDb, '/status/alice'), (snap) => {
      seen.push(snap.val());
    });

    // Initial fire is synchronous — the admin subscribe skipped the read gate.
    expect(seen).toEqual([{ online: false }]);

    // A later admin write re-fires the listener (proving it stayed alive, not
    // torn down by a deferred denial).
    await set(ref(adminDb, '/status/alice'), { online: true });
    expect(seen).toEqual([{ online: false }, { online: true }]);

    unsub();
  });

  test('a page (rule-gated) listener on the same path is denied', () => {
    const sandbox = initializeSandbox();
    setData(sandbox, { '/status/alice': { online: false } });
    setRules(sandbox, AUTH_GATED);

    // Signed-out page handle → `auth == null` → the read gate throws
    // synchronously (the live #401 failure shape), so the page cannot read
    // rules-protected data by requesting a listener.
    const pageDb = getDatabase(sandbox.withAuth(null));
    expect(() => onValue(ref(pageDb, '/status/alice'), () => {})).toThrow(
      'PERMISSION_DENIED',
    );
  });

  test('ENF-2a: getAdminDatabase runTransaction bypasses read and write rules (#1014)', async () => {
    const { get, runTransaction } = await import('pyric/database');
    const sandbox = initializeSandbox();
    setData(sandbox, { '/locked/counter': 10 });
    setRules(sandbox, {
      rules: {
        locked: {
          '.read': false,
          '.write': false,
        },
      },
    });

    const adminDb = getAdminDatabase(sandbox);
    const seen: unknown[] = [];
    const result = await runTransaction(ref(adminDb, '/locked/counter'), (current) => {
      seen.push(current);
      return ((current as number | null) ?? 0) + 5;
    });

    expect(seen).toEqual([10]);
    expect(result.committed).toBe(true);
    expect(result.snapshot.val()).toBe(15);
    expect((await get(ref(adminDb, '/locked/counter'))).val()).toBe(15);

    const pageDb = getDatabase(sandbox.withAuth(null));
    await expect(
      runTransaction(ref(pageDb, '/locked/counter'), (current) => ((current as number | null) ?? 0) + 1),
    ).rejects.toThrow('permission_denied');
  });

  test('ENF-2b: getAdminDatabase onChild* listeners bypass read rules and survive rule changes (#1014)', async () => {
    const { onChildAdded, onChildChanged, onChildRemoved, remove } = await import('pyric/database');
    const sandbox = initializeSandbox();
    setData(sandbox, { '/secret/a': 1 });
    setRules(sandbox, {
      rules: {
        secret: {
          '.read': false,
          '.write': false,
        },
      },
    });

    const adminDb = getAdminDatabase(sandbox);
    const added: Array<[string | null, unknown]> = [];
    const changed: Array<[string | null, unknown]> = [];
    const removed: Array<[string | null, unknown]> = [];

    const unsubAdded = onChildAdded(ref(adminDb, '/secret'), (snap) => {
      added.push([snap.key, snap.val()]);
    });
    const unsubChanged = onChildChanged(ref(adminDb, '/secret'), (snap) => {
      changed.push([snap.key, snap.val()]);
    });
    const unsubRemoved = onChildRemoved(ref(adminDb, '/secret'), (snap) => {
      removed.push([snap.key, snap.val()]);
    });

    expect(added).toEqual([['a', 1]]);

    // Re-applying deny rules must not cancel admin child listeners
    setRules(sandbox, {
      rules: {
        secret: {
          '.read': false,
          '.write': false,
        },
      },
    });

    await set(ref(adminDb, '/secret/b'), 2);
    await set(ref(adminDb, '/secret/a'), 10);
    await remove(ref(adminDb, '/secret/b'));

    expect(added).toEqual([['a', 1], ['b', 2]]);
    expect(changed).toEqual([['a', 10]]);
    expect(removed).toEqual([['b', 2]]);

    unsubAdded();
    unsubChanged();
    unsubRemoved();

    const pageDb = getDatabase(sandbox.withAuth(null));
    expect(() => onChildAdded(ref(pageDb, '/secret'), () => {})).toThrow('PERMISSION_DENIED');
  });
});
