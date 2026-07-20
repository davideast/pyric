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
});
