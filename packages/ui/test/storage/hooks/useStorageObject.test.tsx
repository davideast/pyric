// Real-sandbox probes for `useStorageObject` — fake-indexeddb backs
// the sandbox, nothing mocked except the URL.createObjectURL pair
// (counted, not stubbed away) for the revocation pins.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getStorageSandbox,
  ref,
  updateMetadata,
  uploadBytes,
  type FirebaseStorage,
} from 'pyric/storage';
import { useStorageObject } from '../../../src/storage/hooks/useStorageObject.js';
import { renderHook, waitFor, act } from '../../helpers/render-hook.js';

function uniqueDbName(label: string): string {
  return `pyric-ui-object-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

function makeStorage(label: string): FirebaseStorage {
  const sandbox = initializeSandbox({});
  return getStorageSandbox(sandbox, { dbName: uniqueDbName(label) });
}

type HookProps = { storage: FirebaseStorage | null; path: string | null };
const runHook = (p: HookProps) => useStorageObject(p.storage, p.path);

// Track object-URL lifecycle without changing behavior.
const realCreate = URL.createObjectURL.bind(URL);
const realRevoke = URL.revokeObjectURL.bind(URL);
let created: string[] = [];
let revoked: string[] = [];

beforeEach(() => {
  created = [];
  revoked = [];
  URL.createObjectURL = (blob: Blob) => {
    const url = realCreate(blob);
    created.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
    realRevoke(url);
  };
});

afterEach(() => {
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
});

describe('useStorageObject', () => {
  it('loads metadata for an existing object', async () => {
    const storage = makeStorage('meta');
    await uploadBytes(ref(storage, 'docs/a.txt'), new Blob(['hello']), {
      contentType: 'text/plain',
      customMetadata: { owner: 'alice' },
    });

    const { result } = renderHook(runHook, { storage, path: 'docs/a.txt' });
    await waitFor(() => expect(result.current.status).toBe('success'));

    expect(result.current.metadata).toMatchObject({
      fullPath: 'docs/a.txt',
      name: 'a.txt',
      size: 5,
      contentType: 'text/plain',
      customMetadata: { owner: 'alice' },
    });
    // Lazy: no bytes were fetched, no object URL created.
    expect(result.current.blobStatus).toBe('idle');
    expect(created).toEqual([]);
  });

  it('is idle when storage or path is null', () => {
    const { result } = renderHook(runHook, { storage: null, path: 'docs/a.txt' });
    expect(result.current.status).toBe('idle');
    const { result: r2 } = renderHook(runHook, {
      storage: makeStorage('idle'),
      path: null,
    });
    expect(r2.current.status).toBe('idle');
  });

  it('surfaces a typed error for a missing object', async () => {
    const storage = makeStorage('missing');
    const { result } = renderHook(runHook, { storage, path: 'nope.txt' });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect((result.current.error as { code?: unknown }).code).toBe(
      'storage/object-not-found',
    );
  });

  it('surfaces a rules-denied read as storage/unauthorized', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('denied');
    const authed = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName,
      rules: `
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if request.auth != null;
    }
  }
}`,
    });
    const objectPath = 'b/pyric-default/o/secret.txt';
    await uploadBytes(ref(authed, objectPath), new Blob(['s']));

    const anon = getStorageSandbox(sandbox.withAuth(null), { dbName });
    const { result } = renderHook(runHook, { storage: anon, path: objectPath });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect((result.current.error as { code?: unknown }).code).toBe(
      'storage/unauthorized',
    );
  });

  it('refresh() picks up metadata changes', async () => {
    const storage = makeStorage('refresh');
    await uploadBytes(ref(storage, 'a.txt'), new Blob(['a']));
    const { result } = renderHook(runHook, { storage, path: 'a.txt' });
    await waitFor(() => expect(result.current.status).toBe('success'));

    await updateMetadata(ref(storage, 'a.txt'), { cacheControl: 'no-store' });
    expect(result.current.metadata?.cacheControl).toBeUndefined();
    act(() => result.current.refresh());
    await waitFor(() =>
      expect(result.current.metadata?.cacheControl).toBe('no-store'),
    );
  });

  describe('lazy blob + object-URL lifecycle', () => {
    it('loadBlob fetches the bytes and mints a blob URL', async () => {
      const storage = makeStorage('blob');
      await uploadBytes(ref(storage, 'a.txt'), new Blob(['hello']));
      const { result } = renderHook(runHook, { storage, path: 'a.txt' });
      await waitFor(() => expect(result.current.status).toBe('success'));

      act(() => result.current.loadBlob());
      await waitFor(() => expect(result.current.blobStatus).toBe('success'));
      expect(await result.current.blob!.text()).toBe('hello');
      expect(result.current.blobUrl).toBe(created[0]);
      expect(revoked).toEqual([]);
    });

    it('PIN: revokes the blob URL on unmount', async () => {
      const storage = makeStorage('revoke-unmount');
      await uploadBytes(ref(storage, 'a.txt'), new Blob(['x']));
      const { result, unmount } = renderHook(runHook, { storage, path: 'a.txt' });
      await waitFor(() => expect(result.current.status).toBe('success'));
      act(() => result.current.loadBlob());
      await waitFor(() => expect(result.current.blobStatus).toBe('success'));
      expect(created.length).toBe(1);

      unmount();
      expect(revoked).toEqual([created[0]]);
    });

    it('PIN: revokes the previous blob URL on path change and resets to idle', async () => {
      const storage = makeStorage('revoke-path');
      await uploadBytes(ref(storage, 'a.txt'), new Blob(['a']));
      await uploadBytes(ref(storage, 'b.txt'), new Blob(['b']));

      const { result, rerender } = renderHook(runHook, { storage, path: 'a.txt' });
      await waitFor(() => expect(result.current.status).toBe('success'));
      act(() => result.current.loadBlob());
      await waitFor(() => expect(result.current.blobStatus).toBe('success'));
      const firstUrl = created[0];

      rerender({ storage, path: 'b.txt' });
      // The old object's URL is revoked and the blob is lazy again.
      await waitFor(() => expect(revoked).toEqual([firstUrl]));
      expect(result.current.blobStatus).toBe('idle');
      expect(result.current.blobUrl).toBeUndefined();
    });

    it('surfaces a blob load failure without touching metadata state', async () => {
      const sandbox = initializeSandbox({});
      const dbName = uniqueDbName('blob-denied');
      // Metadata readable, bytes too — but only when authed; the anon
      // handle can read NOTHING, so force the asymmetry via a
      // size-conditioned rule instead: reads allowed, but the object
      // is deleted between metadata load and blob load.
      const storage = getStorageSandbox(sandbox, { dbName });
      await uploadBytes(ref(storage, 'a.txt'), new Blob(['a']));

      const { result } = renderHook(runHook, { storage, path: 'a.txt' });
      await waitFor(() => expect(result.current.status).toBe('success'));

      // Delete out-of-band, then try the bytes.
      const { deleteObject } = await import('pyric/storage');
      await deleteObject(ref(storage, 'a.txt'));
      act(() => result.current.loadBlob());
      await waitFor(() => expect(result.current.blobStatus).toBe('error'));
      expect((result.current.blobError as { code?: unknown }).code).toBe(
        'storage/object-not-found',
      );
      // Metadata state untouched (stale but present — refresh() is the
      // consumer's tool).
      expect(result.current.status).toBe('success');
      expect(created).toEqual([]);
    });
  });
});
