import { describe, expect, it } from 'bun:test';
import { initializeSandbox, createMemoryBackend } from 'pyric/sandbox';
import { initializeApp, deleteApp } from '../../src/app/index.js';
import {
  getAdminDatabase,
  getDatabase,
  ref,
  set,
  get,
  TARGET_SYMBOL,
} from '../../src/database/index.js';
import { setRules, setDefaultPolicy } from '../../src/database/sandbox-controls.js';
import { canonicalizeDatabaseUrl } from '../../src/database/sandbox/backend-for.js';

describe('RTDB Multi-Instance Isolation & Routing', () => {
  it('maintains independent DataTree storage across instances', async () => {
    const sandbox = initializeSandbox();
    const db1 = getDatabase(sandbox, 'https://instance-a.firebaseio.com');
    const db2 = getDatabase(sandbox, 'https://instance-b.firebaseio.com');

    setDefaultPolicy(db1, 'allow');
    setDefaultPolicy(db2, 'allow');

    await set(ref(db1, 'data/key'), 'val-a');
    await set(ref(db2, 'data/key'), 'val-b');

    const snap1 = await get(ref(db1, 'data/key'));
    const snap2 = await get(ref(db2, 'data/key'));

    expect(snap1.val()).toBe('val-a');
    expect(snap2.val()).toBe('val-b');
  });

  it('isolates security rule configurations per instance', async () => {
    const sandbox = initializeSandbox();
    const dbPublic = getDatabase(sandbox, 'https://public-db.firebaseio.com');
    const dbPrivate = getDatabase(sandbox, 'https://private-db.firebaseio.com');

    setRules(dbPublic, {
      rules: {
        '.read': true,
        '.write': true,
      },
    });

    setRules(dbPrivate, {
      rules: {
        '.read': true,
        '.write': false,
      },
    });

    // Write to public db succeeds
    await set(ref(dbPublic, 'items/1'), { name: 'Item 1' });
    expect((await get(ref(dbPublic, 'items/1'))).val()).toEqual({ name: 'Item 1' });

    // Write to private db is denied by its rules
    let writeErr: Error | null = null;
    try {
      await set(ref(dbPrivate, 'items/1'), { name: 'Item 1' });
    } catch (e) {
      writeErr = e as Error;
    }
    expect(writeErr).not.toBeNull();
    expect(writeErr?.message).toContain('PERMISSION_DENIED');

    // Private db data remains empty
    expect((await get(ref(dbPrivate, 'items/1'))).val()).toBeNull();
  });

  it('allows getAdminDatabase to bypass rules per instance', async () => {
    const sandbox = initializeSandbox();
    const dbPrivate = getDatabase(sandbox, 'https://locked-db.firebaseio.com');
    const adminDb = getAdminDatabase(sandbox, 'https://locked-db.firebaseio.com');

    setRules(dbPrivate, {
      rules: {
        '.read': false,
        '.write': false,
      },
    });

    // User client cannot read or write
    expect(async () => await get(ref(dbPrivate, 'admin/secret'))).toThrow();

    // Admin client can write and read
    await set(ref(adminDb, 'admin/secret'), 'classified');
    const snap = await get(ref(adminDb, 'admin/secret'));
    expect(snap.val()).toBe('classified');

    // Other instances do not see this data
    const otherDb = getAdminDatabase(sandbox, 'https://other-db.firebaseio.com');
    expect((await get(ref(otherDb, 'admin/secret'))).val()).toBeNull();
  });

  it('resets all database instance trees on sandbox.resetAll()', async () => {
    const sandbox = initializeSandbox();
    const dbDefault = getDatabase(sandbox);
    const dbSecondary = getDatabase(sandbox, 'https://secondary-db.firebaseio.com');

    setDefaultPolicy(dbDefault, 'allow');
    setDefaultPolicy(dbSecondary, 'allow');

    await set(ref(dbDefault, 'users/u1'), { name: 'Alice' });
    await set(ref(dbSecondary, 'users/u2'), { name: 'Bob' });

    expect((await get(ref(dbDefault, 'users/u1'))).val()).toEqual({ name: 'Alice' });
    expect((await get(ref(dbSecondary, 'users/u2'))).val()).toEqual({ name: 'Bob' });

    sandbox.resetAll();

    expect((await get(ref(dbDefault, 'users/u1'))).val()).toBeNull();
    expect((await get(ref(dbSecondary, 'users/u2'))).val()).toBeNull();
  });

  it('canonicalizes URLs and instance identifiers correctly', async () => {
    const sandbox = initializeSandbox();
    // Shorthand name vs full URL with trailing slash
    const dbShort = getDatabase(sandbox, 'my-instance');
    const dbFull = getDatabase(sandbox, 'https://my-instance.firebaseio.com/');

    setDefaultPolicy(dbShort, 'allow');

    await set(ref(dbShort, 'messages/m1'), 'hello');

    // Both should point to the exact same underlying tree
    const snap = await get(ref(dbFull, 'messages/m1'));
    expect(snap.val()).toBe('hello');
  });

  it('supports app-based multi-instance handles and caching', async () => {
    const app = initializeApp(
      {
        projectId: 'multi-db-app',
        databaseURL: 'https://app-default.firebaseio.com',
      },
      `multi-app-${Date.now()}`,
    );

    try {
      const defaultDb1 = getDatabase(app);
      const defaultDb2 = getDatabase(app, 'https://app-default.firebaseio.com');
      const secondaryDb = getDatabase(app, 'https://app-secondary.firebaseio.com');

      // Default URL lookup should cache the identical handle
      expect(defaultDb1).toBe(defaultDb2);

      // Secondary URL should yield a distinct handle
      expect(secondaryDb).not.toBe(defaultDb1);

      // Verify TARGET_SYMBOL exists on all handles
      expect(TARGET_SYMBOL in defaultDb1).toBe(true);
      expect(TARGET_SYMBOL in secondaryDb).toBe(true);
    } finally {
      await deleteApp(app);
    }
  });

  it('handles context-based getDatabase with url', async () => {
    const sandbox = initializeSandbox();
    const ctx = sandbox.withAuth({ uid: 'alice' });
    const db1 = getDatabase(ctx, 'https://custom-1.firebaseio.com');
    const db2 = getDatabase(ctx, 'https://custom-2.firebaseio.com');

    setDefaultPolicy(db1, 'allow');
    setDefaultPolicy(db2, 'allow');

    await set(ref(db1, 'notes/n1'), 'note 1');
    expect((await get(ref(db1, 'notes/n1'))).val()).toBe('note 1');
    expect((await get(ref(db2, 'notes/n1'))).val()).toBeNull();
  });

  it('canonicalizes uppercase schemes, uppercase plain IDs, query parameters, and DEFAULT keyword', async () => {
    expect(canonicalizeDatabaseUrl('HTTPS://MY-INSTANCE.FIREBASEIO.COM/')).toBe(
      'https://my-instance.firebaseio.com',
    );
    expect(canonicalizeDatabaseUrl('MY-INSTANCE')).toBe('https://my-instance.firebaseio.com');
    expect(canonicalizeDatabaseUrl('DEFAULT')).toBe('default');
    expect(canonicalizeDatabaseUrl('default')).toBe('default');
    expect(canonicalizeDatabaseUrl('  DEFAULT  ')).toBe('default');
    expect(canonicalizeDatabaseUrl('http://localhost:9000?ns=DB1')).toBe(
      'http://localhost:9000?ns=db1',
    );
    expect(canonicalizeDatabaseUrl('http://localhost:9000?NS=db1')).toBe(
      'http://localhost:9000?ns=db1',
    );

    const sandbox = initializeSandbox();
    const dbUpper = getDatabase(sandbox, 'HTTPS://PROJECT-X.FIREBASEIO.COM/');
    const dbPlain = getDatabase(sandbox, 'project-x');
    setDefaultPolicy(dbUpper, 'allow');
    await set(ref(dbUpper, 'settings/theme'), 'dark');
    expect((await get(ref(dbPlain, 'settings/theme'))).val()).toBe('dark');

    const dbDefUpper = getDatabase(sandbox, 'DEFAULT');
    const dbDefImplicit = getDatabase(sandbox);
    setDefaultPolicy(dbDefImplicit, 'allow');
    await set(ref(dbDefImplicit, 'root/val'), 42);
    expect((await get(ref(dbDefUpper, 'root/val'))).val()).toBe(42);
  });

  it('persists and restores both default and secondary database instances with strict isolation', async () => {
    const backend = createMemoryBackend();

    // 1. First sandbox: write to both default and secondary instances
    const sandbox1 = initializeSandbox();
    await sandbox1.enablePersistence({ key: 'multi-db-persist', injectedBackend: backend });

    const defaultDb1 = getDatabase(sandbox1);
    const secDb1 = getDatabase(sandbox1, 'https://secondary.firebaseio.com');
    setDefaultPolicy(defaultDb1, 'allow');
    setDefaultPolicy(secDb1, 'allow');

    await set(ref(defaultDb1, 'default/item'), 'val-default');
    await set(ref(secDb1, 'secondary/item'), 'val-sec');
    await sandbox1.flush();

    // Verify snapshot structure
    const snap1 = sandbox1.snapshot();
    const rtdbService1 = snap1.services?.rtdb as
      | { data?: Record<string, unknown>; instances?: Record<string, { data?: Record<string, unknown> }> }
      | undefined;
    expect(rtdbService1?.data?.default).toEqual({ item: 'val-default' });
    expect(rtdbService1?.instances?.['https://secondary.firebaseio.com']?.data?.secondary).toEqual({ item: 'val-sec' });

    // 2. Second sandbox: restore from persistence
    const sandbox2 = initializeSandbox();
    await sandbox2.enablePersistence({ key: 'multi-db-persist', injectedBackend: backend });

    const defaultDb2 = getDatabase(sandbox2);
    const secDb2 = getDatabase(sandbox2, 'https://secondary.firebaseio.com');
    setDefaultPolicy(defaultDb2, 'allow');
    setDefaultPolicy(secDb2, 'allow');

    // Data is restored correctly to each respective instance
    expect((await get(ref(defaultDb2, 'default/item'))).val()).toBe('val-default');
    expect((await get(ref(secDb2, 'secondary/item'))).val()).toBe('val-sec');

    // Cross-check that neither instance contains the other's data
    expect((await get(ref(defaultDb2, 'secondary/item'))).val()).toBeNull();
    expect((await get(ref(secDb2, 'default/item'))).val()).toBeNull();
  });
});
