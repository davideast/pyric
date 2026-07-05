// Real-sandbox probes for `useStorageSelection` + `useStorageDelete`
// — fake-indexeddb backs the sandbox, nothing mocked. DOM-less via
// react-test-renderer.
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getStorageSandbox,
  listAll,
  ref,
  uploadBytes,
  type FirebaseStorage,
} from 'pyric/storage';
import {
  useStorageDelete,
  type StorageDeleteOutcome,
  type UseStorageDeleteOptions,
} from '../../../src/storage/hooks/useStorageDelete.js';
import { useStorageSelection } from '../../../src/storage/hooks/useStorageSelection.js';
import { useObjectUpload } from '../../../src/storage/hooks/useObjectUpload.js';
import { useStorageList } from '../../../src/storage/hooks/useStorageList.js';
import { renderHook, waitFor, act } from '../../helpers/render-hook.js';

function uniqueDbName(label: string): string {
  return `pyric-ui-delete-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

function makeStorage(label: string): FirebaseStorage {
  const sandbox = initializeSandbox({});
  return getStorageSandbox(sandbox, { dbName: uniqueDbName(label) });
}

async function seed(storage: FirebaseStorage, paths: string[]): Promise<void> {
  for (const p of paths) {
    await uploadBytes(ref(storage, p), new Blob(['x']));
  }
}

describe('useStorageSelection', () => {
  it('tracks toggle/select/deselect/selectAll/clear by fullPath', () => {
    const { result } = renderHook(() => useStorageSelection());
    const a = { kind: 'object' as const, fullPath: 'docs/a.txt' };
    const sub = { kind: 'folder' as const, fullPath: 'docs/sub' };

    act(() => result.current.toggle(a));
    act(() => result.current.select(sub));
    act(() => result.current.select(sub)); // idempotent
    expect(result.current.size).toBe(2);
    expect(result.current.isSelected('docs/a.txt')).toBe(true);
    expect(result.current.selected.map((e) => e.kind)).toEqual(['object', 'folder']);

    act(() => result.current.toggle(a)); // off again
    expect(result.current.isSelected('docs/a.txt')).toBe(false);

    act(() => result.current.selectAll([a, sub]));
    expect(result.current.size).toBe(2);
    act(() => result.current.deselect('docs/sub'));
    expect(result.current.selected.map((e) => e.fullPath)).toEqual(['docs/a.txt']);
    act(() => result.current.clear());
    expect(result.current.size).toBe(0);
  });
});

type DeleteProps = {
  storage: FirebaseStorage | null;
  options?: UseStorageDeleteOptions;
};
const runDelete = (p: DeleteProps) => useStorageDelete(p.storage, p.options);

describe('useStorageDelete', () => {
  it('bulk-deletes objects and reports progress + outcome', async () => {
    const storage = makeStorage('objects');
    await seed(storage, ['docs/a.txt', 'docs/b.txt', 'docs/keep.txt']);

    const { result } = renderHook(runDelete, { storage });
    let outcome: StorageDeleteOutcome | undefined;
    await act(async () => {
      outcome = await result.current.deleteEntries([
        { kind: 'object', fullPath: 'docs/a.txt' },
        { kind: 'object', fullPath: 'docs/b.txt' },
      ]);
    });

    expect(outcome).toEqual({ deleted: ['docs/a.txt', 'docs/b.txt'], failed: [] });
    expect(result.current.progress).toBe(2);
    expect(result.current.isRunning).toBe(false);
    expect(result.current.error).toBeUndefined();
    const listed = await listAll(ref(storage, 'docs'));
    expect(listed.items.map((i) => i.name)).toEqual(['keep.txt']);
  });

  it('recursively deletes a folder via the default listAll-driven impl', async () => {
    const storage = makeStorage('recursive');
    await seed(storage, [
      'docs/sub/a.txt',
      'docs/sub/deep/b.txt',
      'docs/sub/deep/deeper/c.txt',
      'docs/other.txt',
    ]);

    const { result } = renderHook(runDelete, { storage });
    let outcome: StorageDeleteOutcome | undefined;
    await act(async () => {
      outcome = await result.current.deleteEntries([
        { kind: 'folder', fullPath: 'docs/sub' },
      ]);
    });

    expect(outcome).toEqual({ deleted: ['docs/sub'], failed: [] });
    expect(result.current.progress).toBe(3);
    const listed = await listAll(ref(storage, 'docs'));
    expect(listed.items.map((i) => i.name)).toEqual(['other.txt']);
    expect(listed.prefixes).toEqual([]);
  });

  it('PIN: folder delete sweeps create-folder placeholders (no ghost folders)', async () => {
    const storage = makeStorage('placeholder');
    // A folder created via createFolder, with a real file AND an empty
    // subfolder inside.
    const { result } = renderHook((p: { storage: FirebaseStorage }) => {
      const up = useObjectUpload(p.storage, { path: 'docs' });
      const del = useStorageDelete(p.storage);
      return { up, del };
    }, { storage });
    await act(async () => {
      await result.current.up.createFolder('trash');
      await result.current.up.createFolder('trash/empty-sub');
      await result.current.up.upload({ path: 'trash/file.txt', data: new Blob(['x']) });
    });
    let before = await listAll(ref(storage, 'docs'));
    expect(before.prefixes.map((p) => p.fullPath)).toEqual(['docs/trash']);

    await act(async () => {
      await result.current.del.deleteEntries([
        { kind: 'folder', fullPath: 'docs/trash' },
      ]);
    });

    // The walk deleted the file AND both placeholders — nothing left.
    const after = await listAll(ref(storage, 'docs'));
    expect(after.items).toEqual([]);
    expect(after.prefixes).toEqual([]);
  });

  it('removes optimistically through the list seam and rolls back failures', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('rollback');
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
    await uploadBytes(ref(authed, `${base}/sub/b.txt`), new Blob(['b']));

    const anon = getStorageSandbox(sandbox.withAuth(null), { dbName });
    const { result } = renderHook((p: { storage: FirebaseStorage }) => {
      const list = useStorageList(p.storage, base);
      const del = useStorageDelete(p.storage, { list });
      return { list, del };
    }, { storage: anon });
    await waitFor(() => expect(result.current.list.status).toBe('success'));
    expect(result.current.list.entries.length).toBe(2);

    let outcome: StorageDeleteOutcome | undefined;
    await act(async () => {
      outcome = await result.current.del.deleteEntries([
        { kind: 'object', fullPath: `${base}/a.txt` },
        { kind: 'folder', fullPath: `${base}/sub` },
      ]);
    });

    // Both denied → both failed with the typed code…
    expect(outcome!.deleted).toEqual([]);
    expect(outcome!.failed.map((f) => (f.error as { code?: unknown }).code)).toEqual([
      'storage/unauthorized',
      'storage/unauthorized',
    ]);
    expect((result.current.del.error as { code?: unknown }).code).toBe(
      'storage/unauthorized',
    );
    // …and both rows rolled back with the right kinds.
    expect(result.current.list.entries.map((e) => `${e.kind}:${e.name}`)).toEqual([
      'folder:sub',
      'object:a.txt',
    ]);
  });

  it('one failure does not stop the rest of the batch', async () => {
    const storage = makeStorage('partial');
    await seed(storage, ['docs/a.txt', 'docs/b.txt']);
    // Inject an impl that explodes — the folder entry fails, objects
    // still delete.
    const failingImpl = {
      // eslint-disable-next-line require-yield
      start: async function* (): AsyncIterableIterator<never> {
        throw new Error('boom');
      },
    };

    const { result } = renderHook(runDelete, {
      storage,
      options: { impl: failingImpl },
    });
    let outcome: StorageDeleteOutcome | undefined;
    await act(async () => {
      outcome = await result.current.deleteEntries([
        { kind: 'folder', fullPath: 'docs/anything' },
        { kind: 'object', fullPath: 'docs/a.txt' },
      ]);
    });

    expect(outcome!.failed.map((f) => f.fullPath)).toEqual(['docs/anything']);
    expect(outcome!.deleted).toEqual(['docs/a.txt']);
    const listed = await listAll(ref(storage, 'docs'));
    expect(listed.items.map((i) => i.name)).toEqual(['b.txt']);
  });

  it('no-ops on a null handle or empty selection', async () => {
    const { result } = renderHook(runDelete, { storage: null });
    let outcome: StorageDeleteOutcome | undefined;
    await act(async () => {
      outcome = await result.current.deleteEntries([
        { kind: 'object', fullPath: 'docs/a.txt' },
      ]);
    });
    expect(outcome).toEqual({ deleted: [], failed: [] });
    expect(result.current.isRunning).toBe(false);
  });
});
