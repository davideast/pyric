/**
 * Slice 3 — IndexedDB persistence layer.
 *
 * Covers what every higher slice depends on: CRUD round-trips, blob
 * + metadata atomicity, prefix listing semantics, reset, and
 * close/reopen persistence across backend instances.
 *
 * `fake-indexeddb/auto` installs `globalThis.indexedDB` +
 * `globalThis.IDBKeyRange` once at module load. Each test scopes
 * itself to a unique database name so state doesn't leak between
 * cases — there's no per-test factory reset.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import {
  openStorageBackend,
  type StorageBackend,
  type StoredMetadata,
} from '../../src/storage/persistence.js';

/**
 * Generate a unique database name per test invocation so cases don't
 * step on each other's state. fake-indexeddb persists named databases
 * across opens within the same process — same semantics as the real
 * browser API.
 */
function uniqueDbName(label: string): string {
  return `pyric-storage-test-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Minimal `StoredMetadata` with sensible defaults — tests override fields they care about. */
function makeMetadata(overrides: Partial<StoredMetadata> = {}): StoredMetadata {
  const base: StoredMetadata = {
    fullPath: 'sessions/s1.json',
    name: 's1.json',
    bucket: 'pyric-default',
    generation: '1',
    metageneration: '1',
    timeCreated: '2026-05-10T00:00:00.000Z',
    updated: '2026-05-10T00:00:00.000Z',
    size: 17,
    contentType: 'application/json',
  };
  return { ...base, ...overrides };
}

async function openClean(label: string): Promise<{ db: StorageBackend; name: string }> {
  const name = uniqueDbName(label);
  const db = await openStorageBackend(name);
  return { db, name };
}

describe('IndexedDB persistence', () => {
  it('put + getBlob round-trips the content', async () => {
    const { db } = await openClean('put-get');
    const payload = new Blob(['{"session":1}'], { type: 'application/json' });
    await db.put('sessions/s1.json', payload, makeMetadata());

    const got = await db.getBlob('sessions/s1.json');
    expect(got).toBeDefined();
    expect(await got!.text()).toBe('{"session":1}');
    db.close();
  });

  it('put + getMetadata round-trips the record', async () => {
    const { db } = await openClean('put-metadata');
    const md = makeMetadata({ size: 99, customMetadata: { sessionId: 'abc' } });
    await db.put('sessions/s1.json', new Blob([]), md);

    const got = await db.getMetadata('sessions/s1.json');
    expect(got).toEqual(md);
    db.close();
  });

  it('getBlob and getMetadata return undefined for unknown paths', async () => {
    const { db } = await openClean('missing');
    expect(await db.getBlob('nope/missing.json')).toBeUndefined();
    expect(await db.getMetadata('nope/missing.json')).toBeUndefined();
    db.close();
  });

  it('delete removes both the blob and the metadata', async () => {
    const { db } = await openClean('delete');
    await db.put('sessions/s1.json', new Blob(['x']), makeMetadata());

    await db.delete('sessions/s1.json');

    expect(await db.getBlob('sessions/s1.json')).toBeUndefined();
    expect(await db.getMetadata('sessions/s1.json')).toBeUndefined();
    db.close();
  });

  it('put replaces an existing entry (last write wins)', async () => {
    const { db } = await openClean('replace');
    await db.put(
      'sessions/s1.json',
      new Blob(['old']),
      makeMetadata({ generation: '1' }),
    );
    await db.put(
      'sessions/s1.json',
      new Blob(['new']),
      makeMetadata({ generation: '2' }),
    );

    const blob = await db.getBlob('sessions/s1.json');
    expect(await blob!.text()).toBe('new');
    const md = await db.getMetadata('sessions/s1.json');
    expect(md?.generation).toBe('2');
    db.close();
  });

  it('putMetadata updates the record without touching the blob', async () => {
    const { db } = await openClean('put-metadata-only');
    await db.put(
      'sessions/s1.json',
      new Blob(['original-payload']),
      makeMetadata({ metageneration: '1' }),
    );

    await db.putMetadata(
      'sessions/s1.json',
      makeMetadata({ metageneration: '2', customMetadata: { tag: 'review' } }),
    );

    const blob = await db.getBlob('sessions/s1.json');
    expect(await blob!.text()).toBe('original-payload');
    const md = await db.getMetadata('sessions/s1.json');
    expect(md?.metageneration).toBe('2');
    expect(md?.customMetadata).toEqual({ tag: 'review' });
    db.close();
  });

  it('listByPrefix returns matching records in key order', async () => {
    const { db } = await openClean('list');
    // Intentionally seed out of order to confirm IndexedDB returns
    // them sorted by key.
    await db.put('sessions/c.json', new Blob([]), makeMetadata({ fullPath: 'sessions/c.json', name: 'c.json' }));
    await db.put('sessions/a.json', new Blob([]), makeMetadata({ fullPath: 'sessions/a.json', name: 'a.json' }));
    await db.put('sessions/b.json', new Blob([]), makeMetadata({ fullPath: 'sessions/b.json', name: 'b.json' }));
    await db.put('other/x.json',    new Blob([]), makeMetadata({ fullPath: 'other/x.json',    name: 'x.json' }));

    const matches = await db.listByPrefix('sessions/');
    expect(matches.map((m) => m.fullPath)).toEqual([
      'sessions/a.json',
      'sessions/b.json',
      'sessions/c.json',
    ]);
    db.close();
  });

  it('listByPrefix returns an empty array when nothing matches', async () => {
    const { db } = await openClean('list-empty');
    await db.put('a/1.json', new Blob([]), makeMetadata({ fullPath: 'a/1.json', name: '1.json' }));
    expect(await db.listByPrefix('b/')).toEqual([]);
    db.close();
  });

  it('listByPrefix with an exact-path prefix returns just that record', async () => {
    // Path semantics: prefix matching is verbatim string prefix, not
    // segment-bounded. `'sessions/s1.json'` matches itself; callers
    // (Slice 7's listAll) are responsible for adding a trailing slash
    // when they want sub-path-only matches.
    const { db } = await openClean('list-exact');
    await db.put(
      'sessions/s1.json',
      new Blob([]),
      makeMetadata({ fullPath: 'sessions/s1.json', name: 's1.json' }),
    );
    const matches = await db.listByPrefix('sessions/s1.json');
    expect(matches.map((m) => m.fullPath)).toEqual(['sessions/s1.json']);
    db.close();
  });

  it('reset clears every entry from both stores', async () => {
    const { db } = await openClean('reset');
    await db.put('sessions/s1.json', new Blob(['a']), makeMetadata({ fullPath: 'sessions/s1.json', name: 's1.json' }));
    await db.put('sessions/s2.json', new Blob(['b']), makeMetadata({ fullPath: 'sessions/s2.json', name: 's2.json' }));

    await db.reset();

    expect(await db.getBlob('sessions/s1.json')).toBeUndefined();
    expect(await db.getMetadata('sessions/s2.json')).toBeUndefined();
    expect(await db.listByPrefix('sessions/')).toEqual([]);
    db.close();
  });

  it('data survives close + reopen with the same database name', async () => {
    const { db, name } = await openClean('persistence');
    const payload = new Blob(['{"persisted":true}'], { type: 'application/json' });
    await db.put('sessions/s1.json', payload, makeMetadata({ customMetadata: { tag: 'durable' } }));
    db.close();

    const reopened = await openStorageBackend(name);
    const blob = await reopened.getBlob('sessions/s1.json');
    expect(await blob!.text()).toBe('{"persisted":true}');
    const md = await reopened.getMetadata('sessions/s1.json');
    expect(md?.customMetadata).toEqual({ tag: 'durable' });
    reopened.close();
  });

  it('put writes blob + metadata atomically (transactional consistency check)', async () => {
    // We can't easily force a half-applied write through the public
    // API — the transaction either commits or rolls back at the IDB
    // layer. What we *can* verify is that after a successful `put`,
    // BOTH the blob store and the metadata store reflect the write
    // and neither lags behind. Any non-atomic implementation (two
    // separate transactions) would race here.
    const { db } = await openClean('atomic');
    await db.put(
      'sessions/s1.json',
      new Blob(['atomic']),
      makeMetadata({ size: 6, customMetadata: { atomic: 'yes' } }),
    );

    const [blob, md] = await Promise.all([
      db.getBlob('sessions/s1.json'),
      db.getMetadata('sessions/s1.json'),
    ]);
    expect(blob).toBeDefined();
    expect(await blob!.text()).toBe('atomic');
    expect(md?.size).toBe(6);
    expect(md?.customMetadata).toEqual({ atomic: 'yes' });
    db.close();
  });

  it('delete is a no-op when the path is missing', async () => {
    const { db } = await openClean('delete-missing');
    // Should not throw.
    await db.delete('nope/missing.json');
    expect(await db.getBlob('nope/missing.json')).toBeUndefined();
    db.close();
  });
});
