/**
 * Characterization test for ClientStorageReference surface (worker mode).
 *
 * Verifies that ref(storage, path) in worker mode implements toString(),
 * bucket, parent, and root, matching the genuine Firebase Storage reference contract.
 */
import { describe, expect, test } from 'bun:test';
import { getStorage, ref } from '../../../src/serve/worker/client/storage.js';
import type { ClientDb } from '../../../src/serve/worker/client/handles.js';

describe('worker ClientStorageReference surface', () => {
  const fakeDb = { __kind: 'client-db' as const, port: {} as any };

  test('ref implements toString(), bucket, parent, and root', () => {
    const storage = getStorage(fakeDb, undefined, 'test-bucket.appspot.com');
    expect(storage.bucket).toBe('test-bucket.appspot.com');

    const rootRef = ref(storage);
    expect(rootRef.fullPath).toBe('');
    expect(rootRef.name).toBe('');
    expect(rootRef.bucket).toBe('test-bucket.appspot.com');
    expect(rootRef.toString()).toBe('gs://test-bucket.appspot.com/');
    expect(rootRef.parent).toBeNull();
    expect(rootRef.root).toBe(rootRef);

    const childRef = ref(storage, 'feed/photo-123.png');
    expect(childRef.fullPath).toBe('feed/photo-123.png');
    expect(childRef.name).toBe('photo-123.png');
    expect(childRef.bucket).toBe('test-bucket.appspot.com');
    expect(childRef.toString()).toBe('gs://test-bucket.appspot.com/feed/photo-123.png');

    const parentRef = childRef.parent;
    expect(parentRef).not.toBeNull();
    expect(parentRef!.fullPath).toBe('feed');
    expect(parentRef!.name).toBe('feed');
    expect(parentRef!.toString()).toBe('gs://test-bucket.appspot.com/feed');
    expect(parentRef!.parent!.fullPath).toBe('');
    expect(parentRef!.parent!.parent).toBeNull();

    expect(childRef.root.fullPath).toBe('');
    expect(childRef.root.toString()).toBe('gs://test-bucket.appspot.com/');
  });

  test('ref(parent, path) inherits bucket and storage', () => {
    const storage = getStorage(fakeDb, undefined, 'my-bucket');
    const baseRef = ref(storage, 'users');
    const userRef = ref(baseRef, 'ada/profile.jpg');

    expect(userRef.fullPath).toBe('users/ada/profile.jpg');
    expect(userRef.name).toBe('profile.jpg');
    expect(userRef.bucket).toBe('my-bucket');
    expect(userRef.toString()).toBe('gs://my-bucket/users/ada/profile.jpg');
    expect(userRef.storage).toBe(storage);
  });
});
