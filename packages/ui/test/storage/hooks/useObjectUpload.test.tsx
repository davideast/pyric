// Real-sandbox probes for `useObjectUpload` — fake-indexeddb backs
// the sandbox in-process, nothing is mocked. DOM-less via
// react-test-renderer (test/helpers/render-hook.tsx).
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getStorageSandbox,
  getMetadata,
  listAll,
  ref,
  uploadBytes,
  type FirebaseStorage,
} from 'pyric/storage';
import {
  useObjectUpload,
  type UploadTask,
  type UseObjectUploadOptions,
} from '../../../src/storage/hooks/useObjectUpload.js';
import { useStorageList } from '../../../src/storage/hooks/useStorageList.js';
import { renderHook, waitFor, act } from '../../helpers/render-hook.js';

function uniqueDbName(label: string): string {
  return `pyric-ui-upload-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

function makeStorage(label: string): FirebaseStorage {
  const sandbox = initializeSandbox({});
  return getStorageSandbox(sandbox, { dbName: uniqueDbName(label) });
}

type HookProps = {
  storage: FirebaseStorage | null;
  options?: UseObjectUploadOptions;
};
const runHook = (p: HookProps) => useObjectUpload(p.storage, p.options);

describe('useObjectUpload', () => {
  it('uploads a single entry and lands it on the server', async () => {
    const storage = makeStorage('single');
    const { result } = renderHook(runHook, {
      storage,
      options: { path: 'docs' },
    });

    let settled: UploadTask[] = [];
    await act(async () => {
      settled = await result.current.upload({
        path: 'a.txt',
        data: new Blob(['hello'], { type: 'text/plain' }),
      });
    });

    expect(settled.length).toBe(1);
    expect(settled[0]).toMatchObject({
      fullPath: 'docs/a.txt',
      status: 'success',
      bytesTransferred: 5,
      totalBytes: 5,
    });
    expect(settled[0].metadata?.size).toBe(5);
    // Bun's Blob appends a charset to the intrinsic type.
    expect(settled[0].metadata?.contentType).toContain('text/plain');
    // Server truth.
    const listed = await listAll(ref(storage, 'docs'));
    expect(listed.items.map((i) => i.fullPath)).toEqual(['docs/a.txt']);
    // Hook state mirrors the settled tasks.
    expect(result.current.tasks.length).toBe(1);
    expect(result.current.tasks[0].status).toBe('success');
    expect(result.current.isUploading).toBe(false);
  });

  it('uploads multiple files concurrently, one task per file', async () => {
    const storage = makeStorage('multi');
    const { result } = renderHook(runHook, {
      storage,
      options: { path: 'docs' },
    });

    await act(async () => {
      await result.current.upload([
        { path: 'one.txt', data: new Blob(['1']) },
        { path: 'sub/two.txt', data: new Blob(['22']) },
        new File(['333'], 'three.txt', { type: 'text/plain' }),
      ]);
    });

    expect(result.current.tasks.map((t) => t.fullPath).sort()).toEqual([
      'docs/one.txt',
      'docs/sub/two.txt',
      'docs/three.txt',
    ]);
    expect(result.current.tasks.every((t) => t.status === 'success')).toBe(true);
    const listed = await listAll(ref(storage, 'docs'));
    expect(listed.items.map((i) => i.name).sort()).toEqual(['one.txt', 'three.txt']);
    expect(listed.prefixes.map((p) => p.fullPath)).toEqual(['docs/sub']);
  });

  it('is task-shaped: onProgress fires at 0 then at totalBytes (one tick today)', async () => {
    const storage = makeStorage('progress');
    const snapshots: Array<{ status: string; bytes: number; total: number }> = [];
    const { result } = renderHook(runHook, {
      storage,
      options: {
        onProgress: (t) =>
          snapshots.push({ status: t.status, bytes: t.bytesTransferred, total: t.totalBytes }),
      },
    });

    await act(async () => {
      await result.current.upload({ path: 'p.bin', data: new Uint8Array(8) });
    });

    expect(snapshots).toEqual([
      { status: 'running', bytes: 0, total: 8 },
      { status: 'success', bytes: 8, total: 8 },
    ]);
  });

  it('inserts optimistically through the useStorageList seam (no refresh needed)', async () => {
    const storage = makeStorage('optimistic');
    await uploadBytes(ref(storage, 'docs/existing.txt'), new Blob(['x']));

    const { result } = renderHook((p: { storage: FirebaseStorage }) => {
      const list = useStorageList(p.storage, 'docs');
      const up = useObjectUpload(p.storage, { path: 'docs', list });
      return { list, up };
    }, { storage });
    await waitFor(() => expect(result.current.list.status).toBe('success'));

    await act(async () => {
      await result.current.up.upload({ path: 'new.txt', data: new Blob(['n']) });
    });
    // The list shows the row without a refresh (read-via-get, no realtime).
    expect(result.current.list.items.map((i) => i.name)).toEqual([
      'existing.txt',
      'new.txt',
    ]);
  });

  it('rolls back the optimistic row and surfaces the typed StorageError on a denied write', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('denied');
    const authed = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName,
      rules: `
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read: if true;
      allow write: if request.auth != null;
    }
  }
}`,
    });
    const base = 'b/pyric-default/o/docs';
    await uploadBytes(ref(authed, `${base}/existing.txt`), new Blob(['x']));

    const anon = getStorageSandbox(sandbox.withAuth(null), { dbName });
    const errors: UploadTask[] = [];
    const { result } = renderHook((p: { storage: FirebaseStorage }) => {
      const list = useStorageList(p.storage, base);
      const up = useObjectUpload(p.storage, {
        path: base,
        list,
        onError: (t) => errors.push(t),
      });
      return { list, up };
    }, { storage: anon });
    await waitFor(() => expect(result.current.list.status).toBe('success'));
    expect(result.current.list.items.length).toBe(1);

    let settled: UploadTask[] = [];
    await act(async () => {
      settled = await result.current.up.upload({
        path: 'blocked.txt',
        data: new Blob(['nope']),
      });
    });

    // Typed error on the task, onError fired, promise did NOT reject.
    expect(settled[0].status).toBe('error');
    expect((settled[0].error as { code?: unknown }).code).toBe('storage/unauthorized');
    expect(errors.length).toBe(1);
    // Rollback: the optimistic row is gone, the pre-existing one stays.
    expect(result.current.list.items.map((i) => i.name)).toEqual(['existing.txt']);
    // Server truth agrees.
    const listed = await listAll(ref(authed, base));
    expect(listed.items.map((i) => i.name)).toEqual(['existing.txt']);
  });

  it('one bad file does not mask the others in a batch', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('partial');
    const storage = getStorageSandbox(sandbox, {
      dbName,
      rules: `
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read: if true;
      allow write: if request.resource.size < 4;
    }
  }
}`,
    });
    const base = 'b/pyric-default/o/docs';
    const { result } = renderHook(runHook, { storage, options: { path: base } });

    let settled: UploadTask[] = [];
    await act(async () => {
      settled = await result.current.upload([
        { path: 'small.txt', data: new Blob(['ok']) },
        { path: 'big.txt', data: new Blob(['too large']) },
      ]);
    });

    expect(settled.map((t) => t.status)).toEqual(['success', 'error']);
    const listed = await listAll(ref(storage, base));
    expect(listed.items.map((i) => i.name)).toEqual(['small.txt']);
  });

  it('clearCompleted drops settled tasks', async () => {
    const storage = makeStorage('clear');
    const { result } = renderHook(runHook, { storage, options: {} });
    await act(async () => {
      await result.current.upload({ path: 'a.txt', data: new Blob(['a']) });
    });
    expect(result.current.tasks.length).toBe(1);
    act(() => result.current.clearCompleted());
    expect(result.current.tasks).toEqual([]);
  });

  describe('createFolder (the section 3 pinned default)', () => {
    it('writes a zero-byte <path>/ placeholder that is hidden from items at every level', async () => {
      const storage = makeStorage('folder');
      await uploadBytes(ref(storage, 'docs/a.txt'), new Blob(['a']));

      const { result } = renderHook(runHook, {
        storage,
        options: { path: 'docs' },
      });
      await act(async () => {
        await result.current.createFolder('newfolder');
      });

      // PIN 1: the placeholder is a zero-byte object named `<path>/`.
      const folder = ref(storage, 'docs/newfolder');
      const placeholderRef = {
        storage,
        bucket: folder.bucket,
        fullPath: 'docs/newfolder/',
        name: '',
        parent: folder,
        root: folder.root,
        toString: () => `${folder.toString()}/`,
      };
      const md = await getMetadata(placeholderRef);
      expect(md.fullPath).toBe('docs/newfolder/');
      expect(md.size).toBe(0);

      // PIN 2: hidden from items — the parent listing shows the folder
      // ONLY as a prefix…
      const parent = await listAll(ref(storage, 'docs'));
      expect(parent.prefixes.map((p) => p.fullPath)).toEqual(['docs/newfolder']);
      expect(parent.items.map((i) => i.fullPath)).toEqual(['docs/a.txt']);
      // …and the folder's own listing shows NO phantom file.
      const inside = await listAll(folder);
      expect(inside.items).toEqual([]);
      expect(inside.prefixes).toEqual([]);
    });

    it('optimistically inserts the folder as a prefix through the seam, rolls back on denial', async () => {
      const storage = makeStorage('folder-optimistic');
      await uploadBytes(ref(storage, 'docs/a.txt'), new Blob(['a']));

      const { result } = renderHook((p: { storage: FirebaseStorage }) => {
        const list = useStorageList(p.storage, 'docs');
        const up = useObjectUpload(p.storage, { path: 'docs', list });
        return { list, up };
      }, { storage });
      await waitFor(() => expect(result.current.list.status).toBe('success'));

      await act(async () => {
        await result.current.up.createFolder('newfolder');
      });
      // Folder row appears as a FOLDER entry without refresh.
      expect(result.current.list.entries.map((e) => `${e.kind}:${e.name}`)).toEqual([
        'folder:newfolder',
        'object:a.txt',
      ]);
      // And survives a refresh (server truth has the placeholder).
      act(() => result.current.list.refresh());
      await waitFor(() =>
        expect(result.current.list.prefixes.map((p) => p.fullPath)).toEqual([
          'docs/newfolder',
        ]),
      );
    });

    it('rolls back the optimistic prefix and rethrows on a denied write', async () => {
      const sandbox = initializeSandbox({});
      const dbName = uniqueDbName('folder-denied');
      const authed = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
        dbName,
        rules: `
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read: if true;
      allow write: if request.auth != null;
    }
  }
}`,
      });
      const base = 'b/pyric-default/o/docs';
      await uploadBytes(ref(authed, `${base}/a.txt`), new Blob(['a']));

      const anon = getStorageSandbox(sandbox.withAuth(null), { dbName });
      const { result } = renderHook((p: { storage: FirebaseStorage }) => {
        const list = useStorageList(p.storage, base);
        const up = useObjectUpload(p.storage, { path: base, list });
        return { list, up };
      }, { storage: anon });
      await waitFor(() => expect(result.current.list.status).toBe('success'));

      let thrown: unknown;
      await act(async () => {
        try {
          await result.current.up.createFolder('blocked');
        } catch (e) {
          thrown = e;
        }
      });
      expect((thrown as { code?: unknown }).code).toBe('storage/unauthorized');
      expect(result.current.list.prefixes).toEqual([]);
    });
  });
});
