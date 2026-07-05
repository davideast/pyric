/**
 * Slice 4 — Service factory + Sandbox integration.
 *
 * Verifies the caching invariants `getStorage` advertises and the
 * routing it does for `Sandbox` vs `SandboxContext` inputs. The
 * underlying IDB backend is shared per Sandbox so future read/write
 * ops (Slice 5) see one another's data across contexts; this slice
 * confirms that via the internal `getStorageService` accessor.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getStorageSandbox, getStorageService, targetOf } from '../../src/storage/service.js';

function uniqueDbName(label: string): string {
  return `pyric-storage-test-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

describe('getStorageSandbox', () => {
  it('accepts a bare Sandbox and wires up an anonymous context', () => {
    const sandbox = initializeSandbox({});
    const storage = getStorageSandbox(sandbox, { dbName: uniqueDbName('bare-sandbox') });
    const t = targetOf(storage);
    if (t.kind !== 'sandbox') throw new Error('expected sandbox target');
    expect(t.sandbox).toBe(sandbox);
    expect(t.context.auth).toBe(null);
    expect(t.bucket).toBe('pyric-default');
  });

  it('accepts a SandboxContext and binds the handle to it', () => {
    const sandbox = initializeSandbox({});
    const ctx = sandbox.withAuth({ uid: 'alice' });
    const storage = getStorageSandbox(ctx, { dbName: uniqueDbName('context') });
    const t = targetOf(storage);
    if (t.kind !== 'sandbox') throw new Error('expected sandbox target');
    expect(t.context).toBe(ctx);
    expect(t.context.auth).toEqual({ uid: 'alice' });
  });

  it('returns the same handle for repeated calls on the same context', () => {
    const sandbox = initializeSandbox({});
    const ctx = sandbox.withAuth({ uid: 'alice' });
    const dbName = uniqueDbName('idempotent');
    const a = getStorageSandbox(ctx, { dbName });
    const b = getStorageSandbox(ctx, { dbName });
    expect(a).toBe(b);
  });

  it('ST-B3: returns the same handle for repeated bare-Sandbox calls', () => {
    // `Sandbox.withAuth(null)` mints a fresh context each call, so
    // without the bare-Sandbox cache this returned two handles. The
    // docstring + COMPAT claim identity-stability per Sandbox.
    const sandbox = initializeSandbox({});
    const a = getStorageSandbox(sandbox, { dbName: uniqueDbName('bare-stable') });
    const b = getStorageSandbox(sandbox);
    expect(a).toBe(b);
    const ta = targetOf(a);
    const tb = targetOf(b);
    if (ta.kind !== 'sandbox' || tb.kind !== 'sandbox') throw new Error('expected sandbox targets');
    expect(ta.context).toBe(tb.context);
  });

  it('returns different handles for different contexts on the same sandbox', () => {
    const sandbox = initializeSandbox({});
    const alice = sandbox.withAuth({ uid: 'alice' });
    const bob = sandbox.withAuth({ uid: 'bob' });
    const dbName = uniqueDbName('two-contexts');
    const aliceStorage = getStorageSandbox(alice, { dbName });
    const bobStorage = getStorageSandbox(bob, { dbName });
    expect(aliceStorage).not.toBe(bobStorage);
    const at = targetOf(aliceStorage);
    const bt = targetOf(bobStorage);
    if (at.kind !== 'sandbox' || bt.kind !== 'sandbox') throw new Error('expected sandbox targets');
    expect(at.context).toBe(alice);
    expect(bt.context).toBe(bob);
  });

  it('shares the underlying StorageService across contexts on the same sandbox', async () => {
    const sandbox = initializeSandbox({});
    const alice = sandbox.withAuth({ uid: 'alice' });
    const bob = sandbox.withAuth({ uid: 'bob' });
    const dbName = uniqueDbName('shared-service');

    const aliceStorage = getStorageSandbox(alice, { dbName });
    const bobStorage = getStorageSandbox(bob, { dbName });

    const [aliceService, bobService] = await Promise.all([
      getStorageService(aliceStorage),
      getStorageService(bobStorage),
    ]);
    expect(aliceService).toBe(bobService);
  });

  it('isolates services across independent Sandbox instances', async () => {
    const a = initializeSandbox({});
    const b = initializeSandbox({});
    const aStorage = getStorageSandbox(a, { dbName: uniqueDbName('iso-a') });
    const bStorage = getStorageSandbox(b, { dbName: uniqueDbName('iso-b') });
    const [aService, bService] = await Promise.all([
      getStorageService(aStorage),
      getStorageService(bStorage),
    ]);
    expect(aService).not.toBe(bService);
  });

  it("dbName only takes effect on the sandbox's first getStorage call", async () => {
    // The cache is keyed by Sandbox, so options.dbName supplied on a
    // SECOND call (after the service is already constructed) is
    // ignored. Verify: open one backend with dbName 'first', write a
    // value, then 'open' again with dbName 'second' — the same
    // backend is returned and the original value is still there.
    const sandbox = initializeSandbox({});
    const first = uniqueDbName('first');
    const second = uniqueDbName('second');

    const handleA = getStorageSandbox(sandbox, { dbName: first });
    const serviceA = await getStorageService(handleA);
    await serviceA.backend.put(
      'sessions/s1.json',
      new Blob(['probe']),
      {
        fullPath: 'sessions/s1.json',
        name: 's1.json',
        bucket: 'pyric-default',
        generation: '1',
        metageneration: '1',
        timeCreated: '2026-05-10T00:00:00.000Z',
        updated: '2026-05-10T00:00:00.000Z',
        size: 5,
      },
    );

    const handleB = getStorageSandbox(sandbox, { dbName: second });
    const serviceB = await getStorageService(handleB);
    expect(serviceB).toBe(serviceA);
    expect(await serviceB.backend.getBlob('sessions/s1.json')).toBeDefined();
  });

  it('records the bucket value on the handle (round-trips even without enforcement)', () => {
    const sandbox = initializeSandbox({});
    const storage = getStorageSandbox(sandbox, {
      bucket: 'custom-bucket',
      dbName: uniqueDbName('custom-bucket'),
    });
    const t = targetOf(storage);
    if (t.kind !== 'sandbox') throw new Error('expected sandbox target');
    expect(t.bucket).toBe('custom-bucket');
  });

  it('rejects an object that was not produced by a factory', () => {
    const fake = Object.freeze({
      sandbox: undefined,
      context: undefined,
      bucket: 'fake',
    } as unknown as ReturnType<typeof getStorageSandbox>);
    expect(() => getStorageService(fake)).toThrow(/not a FirebaseStorage handle/);
  });
});
