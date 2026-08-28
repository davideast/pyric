import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getDatabase,
  getAdminDatabase,
  get,
  set,
  ref as dbRef,
  sandbox as rtdbSandbox,
  DEFAULT_DENY_RTDB_RULES,
  DEFAULT_OPEN_RTDB_RULES,
} from '../../src/database/index.js';

describe('RTDB sandbox default security policy', () => {
  it('rejects client mutations and reads under default deny policy', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox.withAuth({ uid: 'client-user' }));

    // Set default policy to deny
    rtdbSandbox.setDefaultPolicy(db, 'deny');

    const testRef = dbRef(db, '/users/alice');

    // Client write is rejected with PERMISSION_DENIED
    let writeError: unknown = null;
    try {
      await set(testRef, { name: 'Alice' });
    } catch (err) {
      writeError = err;
    }
    expect(writeError).toBeInstanceOf(Error);
    expect((writeError as Error).message).toContain('PERMISSION_DENIED');

    // Client read is rejected with PERMISSION_DENIED
    let readError: unknown = null;
    try {
      await get(testRef);
    } catch (err) {
      readError = err;
    }
    expect(readError).toBeInstanceOf(Error);
    expect((readError as Error).message).toContain('PERMISSION_DENIED');

    // Admin handle bypass via getAdminDatabase succeeds despite deny policy
    const adminDb = getAdminDatabase(sandbox);
    await set(dbRef(adminDb, '/users/alice'), { name: 'Alice Admin' });
    const adminSnap = await get(dbRef(adminDb, '/users/alice'));
    expect(adminSnap.val()).toEqual({ name: 'Alice Admin' });

    // .info paths remain readable even under deny policy
    const infoSnap = await get(dbRef(db, '/.info/serverTimeOffset'));
    expect(infoSnap.val()).toBe(0);
  });

  it('allows client operations when explicitly switched to permissive or open rules', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox.withAuth({ uid: 'client-user' }));

    // Explicitly set DEFAULT_DENY_RTDB_RULES
    rtdbSandbox.setRules(db, DEFAULT_DENY_RTDB_RULES);
    await expect(set(dbRef(db, '/test'), 'data')).rejects.toThrow('PERMISSION_DENIED');

    // Explicitly switch to DEFAULT_OPEN_RTDB_RULES
    rtdbSandbox.setRules(db, DEFAULT_OPEN_RTDB_RULES);
    await set(dbRef(db, '/test'), 'open-data');
    const snap = await get(dbRef(db, '/test'));
    expect(snap.val()).toBe('open-data');

    // Clear rules with setDefaultPolicy('allow')
    rtdbSandbox.setRules(db, null);
    rtdbSandbox.setDefaultPolicy(db, 'allow');
    await set(dbRef(db, '/test2'), 'permissive-data');
    const snap2 = await get(dbRef(db, '/test2'));
    expect(snap2.val()).toBe('permissive-data');
  });
});
