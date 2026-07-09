// Real-sandbox probes for `useStorageList` — same harness family as
// `packages/pyric/test/storage/*`: fake-indexeddb backs the sandbox
// in-process, nothing is mocked. Hooks run DOM-less via
// `react-test-renderer` (see test/helpers/render-hook.tsx).
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getStorageSandbox,
  ref,
  uploadBytes,
  type FirebaseStorage,
} from 'pyric/storage';
import { useStorageList } from '../../../src/storage/hooks/useStorageList.js';
import { renderHook, waitFor, act } from '../../helpers/render-hook.js';

function uniqueDbName(label: string): string {
  return `pyric-ui-storagelist-${label}-${Math.random().toString(36).slice(2, 10)}`;
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

type HookProps = { storage: FirebaseStorage | null; path: string };
const runHook = (p: HookProps) => useStorageList(p.storage, p.path);

describe('useStorageList', () => {
  it('lists direct child objects and synthesizes folders from deeper paths', async () => {
    const storage = makeStorage('synthesis');
    await seed(storage, [
      'docs/a.txt',
      'docs/readme.md',
      'docs/sub/b.txt',
      'docs/sub/deep/c.txt',
      'docs/zarchive/d.txt',
      'other/e.txt',
    ]);

    const { result } = renderHook(runHook, { storage, path: 'docs' });
    await waitFor(() => expect(result.current.status).toBe('success'));

    expect(result.current.items.map((i) => i.fullPath)).toEqual([
      'docs/a.txt',
      'docs/readme.md',
    ]);
    // `docs/sub` appears once despite two descendants; `other/` is
    // outside the listed path.
    expect(result.current.prefixes.map((p) => p.fullPath)).toEqual([
      'docs/sub',
      'docs/zarchive',
    ]);
    // Merged row model: folders first, then objects, names = last segment.
    expect(
      result.current.entries.map((e) => `${e.kind}:${e.name}`),
    ).toEqual([
      'folder:sub',
      'folder:zarchive',
      'object:a.txt',
      'object:readme.md',
    ]);
    expect(result.current.error).toBeUndefined();
  });

  it('lists the bucket root for path ""', async () => {
    const storage = makeStorage('root');
    await seed(storage, ['top.txt', 'folder/nested.txt']);

    const { result } = renderHook(runHook, { storage, path: '' });
    await waitFor(() => expect(result.current.status).toBe('success'));

    expect(result.current.items.map((i) => i.fullPath)).toEqual(['top.txt']);
    expect(result.current.prefixes.map((p) => p.fullPath)).toEqual(['folder']);
  });

  it('normalizes leading/trailing slashes in path', async () => {
    const storage = makeStorage('normalize');
    await seed(storage, ['docs/a.txt']);

    const { result } = renderHook(runHook, { storage, path: '/docs/' });
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.items.map((i) => i.fullPath)).toEqual(['docs/a.txt']);
  });

  it('succeeds with empty arrays for a path with no children', async () => {
    const storage = makeStorage('empty');
    const { result } = renderHook(runHook, { storage, path: 'nothing-here' });
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.items).toEqual([]);
    expect(result.current.prefixes).toEqual([]);
    expect(result.current.entries).toEqual([]);
  });

  it('is idle (not loading) when storage is null', () => {
    const { result } = renderHook(runHook, { storage: null, path: 'docs' });
    expect(result.current.status).toBe('idle');
    expect(result.current.items).toEqual([]);
    expect(result.current.error).toBeUndefined();
  });

  it('re-lists when the path changes', async () => {
    const storage = makeStorage('pathchange');
    await seed(storage, ['a/one.txt', 'b/two.txt']);

    const { result, rerender } = renderHook(runHook, { storage, path: 'a' });
    await waitFor(() =>
      expect(result.current.items.map((i) => i.name)).toEqual(['one.txt']),
    );

    rerender({ storage, path: 'b' });
    await waitFor(() =>
      expect(result.current.items.map((i) => i.name)).toEqual(['two.txt']),
    );
  });

  it('refresh() picks up an out-of-band upload', async () => {
    const storage = makeStorage('refresh');
    await seed(storage, ['docs/a.txt']);

    const { result } = renderHook(runHook, { storage, path: 'docs' });
    await waitFor(() => expect(result.current.items.length).toBe(1));

    await uploadBytes(ref(storage, 'docs/b.txt'), new Blob(['b']));
    // No realtime — the new object only appears on refresh.
    expect(result.current.items.length).toBe(1);

    act(() => result.current.refresh());
    await waitFor(() =>
      expect(result.current.items.map((i) => i.name)).toEqual(['a.txt', 'b.txt']),
    );
  });

  it('surfaces a rules-denied list as a typed StorageError (ST-B2)', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('denied');
    // First factory call wins the ruleset; seed under an authed
    // identity. The `/b/{bucket}/o` wrapper means object paths carry
    // the `b/<bucket>/o/` prefix — same convention as
    // packages/pyric/test/storage/list-rules.test.ts.
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
    const protectedPath = 'b/pyric-default/o/protected';
    await uploadBytes(ref(authed, `${protectedPath}/secret.txt`), new Blob(['s']));

    const anon = getStorageSandbox(sandbox.withAuth(null), { dbName });
    const { result } = renderHook(runHook, { storage: anon, path: protectedPath });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect((result.current.error as { code?: unknown }).code).toBe(
      'storage/unauthorized',
    );
    expect(result.current.items).toEqual([]);
    expect(result.current.entries).toEqual([]);

    // The same sandbox, authed, succeeds — the denial is rules, not plumbing.
    const { result: authedResult } = renderHook(runHook, {
      storage: authed,
      path: protectedPath,
    });
    await waitFor(() => expect(authedResult.current.status).toBe('success'));
    expect(authedResult.current.items.map((i) => i.name)).toEqual(['secret.txt']);
  });

  describe('optimistic seam', () => {
    it('insertItem adds a direct child object in sorted position', async () => {
      const storage = makeStorage('opt-insert');
      await seed(storage, ['docs/a.txt', 'docs/c.txt']);

      const { result } = renderHook(runHook, { storage, path: 'docs' });
      await waitFor(() => expect(result.current.status).toBe('success'));

      act(() => result.current.insertItem('docs/b.txt'));
      expect(result.current.items.map((i) => i.name)).toEqual([
        'a.txt',
        'b.txt',
        'c.txt',
      ]);
    });

    it('insertItem synthesizes a folder for a deeper descendant, deduped', async () => {
      const storage = makeStorage('opt-folder');
      await seed(storage, ['docs/a.txt']);

      const { result } = renderHook(runHook, { storage, path: 'docs' });
      await waitFor(() => expect(result.current.status).toBe('success'));

      act(() => result.current.insertItem('docs/sub/deep/file.txt'));
      act(() => result.current.insertItem('docs/sub/other.txt'));
      expect(result.current.prefixes.map((p) => p.fullPath)).toEqual(['docs/sub']);
      expect(result.current.entries[0]).toMatchObject({
        kind: 'folder',
        name: 'sub',
      });
    });

    it('insertItem with a trailing slash inserts a folder prefix, not an item', async () => {
      const storage = makeStorage('opt-trailing');
      await seed(storage, ['docs/a.txt']);

      const { result } = renderHook(runHook, { storage, path: 'docs' });
      await waitFor(() => expect(result.current.status).toBe('success'));

      act(() => result.current.insertItem('docs/newfolder/'));
      expect(result.current.items.map((i) => i.fullPath)).toEqual(['docs/a.txt']);
      expect(result.current.prefixes.map((p) => p.fullPath)).toEqual([
        'docs/newfolder',
      ]);
      expect(result.current.entries[0]).toMatchObject({
        kind: 'folder',
        name: 'newfolder',
      });
      // removeItem rollback addresses the prefix by its slash-less path.
      act(() => result.current.removeItem('docs/newfolder'));
      expect(result.current.prefixes).toEqual([]);
    });

    it('insertItem ignores duplicates and paths outside the listed path', async () => {
      const storage = makeStorage('opt-outside');
      await seed(storage, ['docs/a.txt']);

      const { result } = renderHook(runHook, { storage, path: 'docs' });
      await waitFor(() => expect(result.current.status).toBe('success'));

      act(() => result.current.insertItem('docs/a.txt'));
      act(() => result.current.insertItem('elsewhere/b.txt'));
      expect(result.current.items.map((i) => i.fullPath)).toEqual(['docs/a.txt']);
      expect(result.current.prefixes).toEqual([]);
    });

    it('removeItem drops an object or folder; refresh restores server truth', async () => {
      const storage = makeStorage('opt-remove');
      await seed(storage, ['docs/a.txt', 'docs/sub/b.txt']);

      const { result } = renderHook(runHook, { storage, path: 'docs' });
      await waitFor(() => expect(result.current.status).toBe('success'));
      expect(result.current.entries.length).toBe(2);

      act(() => result.current.removeItem('docs/a.txt'));
      act(() => result.current.removeItem('docs/sub'));
      expect(result.current.entries).toEqual([]);

      // The removals were optimistic-local only — server truth returns.
      act(() => result.current.refresh());
      await waitFor(() => expect(result.current.entries.length).toBe(2));
    });

    it('removeItem after a deep insert reverses the SYNTHESIZED folder row (failed-upload rollback)', async () => {
      const storage = makeStorage('opt-precise-rollback');
      await seed(storage, ['docs/a.txt']);

      const { result } = renderHook(runHook, { storage, path: 'docs' });
      await waitFor(() => expect(result.current.status).toBe('success'));

      // A deep upload inserts its own path; the visible row is the synthesized
      // first-segment folder. Rolling back by the UPLOAD's path must remove it.
      act(() => result.current.insertItem('docs/sub/deep/file.txt'));
      expect(result.current.prefixes.map((p) => p.fullPath)).toEqual(['docs/sub']);
      act(() => result.current.removeItem('docs/sub/deep/file.txt'));
      expect(result.current.prefixes).toEqual([]);
      expect(result.current.items.map((i) => i.fullPath)).toEqual(['docs/a.txt']);
    });

    it('removeItem after a NO-OP insert removes nothing (a real folder survives a failed upload into it)', async () => {
      const storage = makeStorage('opt-noop-rollback');
      await seed(storage, ['docs/sub/real.txt']);

      const { result } = renderHook(runHook, { storage, path: 'docs' });
      await waitFor(() => expect(result.current.status).toBe('success'));
      expect(result.current.prefixes.map((p) => p.fullPath)).toEqual(['docs/sub']);

      // Upload into the EXISTING folder: the insert is a no-op (the prefix is
      // server truth), so the failed upload's rollback must not delete it.
      act(() => result.current.insertItem('docs/sub/newfile.txt'));
      act(() => result.current.removeItem('docs/sub/newfile.txt'));
      expect(result.current.prefixes.map((p) => p.fullPath)).toEqual(['docs/sub']);
    });
  });
});
