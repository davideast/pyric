import { afterEach, describe, expect, test } from 'bun:test';
import { deleteApp, getApps } from '../../src/app/index.js';
import { getDatabase } from '../../src/database/index.js';
import { inProcessApp, sharedWorkerApp } from './arms.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe.each([
  ['in-process', inProcessApp],
  ['shared-worker remote', sharedWorkerApp],
])('pyric-admin/database DataSnapshot.val() immutability ($0)', (_label, makeApp) => {
  test('mutating snap.val() in place does not alter subsequent val(), child().val(), or exportVal() calls', async () => {
    const db = getDatabase(makeApp());
    await db.ref('users/u1').set({
      profile: { role: 'viewer' },
      tags: ['alpha', 'beta'],
    });

    const snap = await db.ref('users/u1').get();
    const firstVal = snap.val() as { profile: { role: string }; tags: string[] };
    firstVal.profile.role = 'tampered';
    firstVal.tags.push('injected');

    expect(snap.val()).toEqual({
      profile: { role: 'viewer' },
      tags: ['alpha', 'beta'],
    });
    expect(snap.child('profile/role').val()).toBe('viewer');
    expect(snap.exportVal()).toEqual({
      profile: { role: 'viewer' },
      tags: { '0': 'alpha', '1': 'beta' },
    });
  });
});
