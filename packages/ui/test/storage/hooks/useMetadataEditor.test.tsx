// Real-sandbox probes for `useMetadataEditor` — fake-indexeddb backs
// the sandbox, nothing mocked. DOM-less via react-test-renderer.
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getMetadata,
  getStorageSandbox,
  ref,
  uploadBytes,
  type FirebaseStorage,
} from 'pyric/storage';
import {
  useMetadataEditor,
  type UseMetadataEditorOptions,
} from '../../../src/storage/hooks/useMetadataEditor.js';
import { renderHook, waitFor, act } from '../../helpers/render-hook.js';
import { OPEN_STORAGE_RULES } from '../open-storage-rules.js';

function uniqueDbName(label: string): string {
  return `pyric-ui-metaedit-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

function makeStorage(label: string): FirebaseStorage {
  const sandbox = initializeSandbox({});
  return getStorageSandbox(sandbox, {
    dbName: uniqueDbName(label),
    rules: OPEN_STORAGE_RULES,
  });
}

type HookProps = {
  storage: FirebaseStorage | null;
  path: string | null;
  options?: UseMetadataEditorOptions;
};
const runHook = (p: HookProps) => useMetadataEditor(p.storage, p.path, p.options);

describe('useMetadataEditor', () => {
  it('initializes from the metadata snapshot', () => {
    const { result } = renderHook(runHook, {
      storage: null,
      path: null,
      options: {
        initial: {
          contentType: 'text/plain',
          cacheControl: 'no-store',
          customMetadata: { owner: 'alice', team: 'core' },
        },
      },
    });
    expect(result.current.contentType).toBe('text/plain');
    expect(result.current.cacheControl).toBe('no-store');
    expect(result.current.custom.map((e) => `${e.key}=${e.value}`)).toEqual([
      'owner=alice',
      'team=core',
    ]);
    expect(result.current.isDirty).toBe(false);
    expect(result.current.isValid).toBe(true);
  });

  it('edits fields and k/v rows through the named helpers; reset restores', () => {
    const { result } = renderHook(runHook, {
      storage: null,
      path: null,
      options: { initial: { customMetadata: { owner: 'alice' } } },
    });

    act(() => result.current.setContentType('application/json'));
    act(() => result.current.setCacheControl('max-age=60'));
    act(() => result.current.addCustomEntry('env', 'prod'));
    act(() =>
      result.current.setCustomValue(result.current.custom[0].id, 'bob'),
    );
    expect(result.current.isDirty).toBe(true);
    expect(result.current.toPatch()).toEqual({
      contentType: 'application/json',
      cacheControl: 'max-age=60',
      customMetadata: { owner: 'bob', env: 'prod' },
    });

    act(() => result.current.removeCustomEntry(result.current.custom[1].id));
    expect(result.current.toPatch().customMetadata).toEqual({ owner: 'bob' });

    act(() => result.current.reset());
    expect(result.current.isDirty).toBe(false);
    expect(result.current.contentType).toBe('');
    expect(result.current.custom.map((e) => `${e.key}=${e.value}`)).toEqual([
      'owner=alice',
    ]);
  });

  it('validates empty and duplicate keys', () => {
    const { result } = renderHook(runHook, { storage: null, path: null });

    act(() => result.current.addCustomEntry());
    expect(result.current.isValid).toBe(false);
    expect(result.current.custom[0].error).toBe('Key is required');

    act(() => result.current.setCustomKey(result.current.custom[0].id, 'k'));
    expect(result.current.isValid).toBe(true);

    act(() => result.current.addCustomEntry('k', 'other'));
    expect(result.current.errorCount).toBe(2);
    expect(result.current.custom.map((e) => e.error)).toEqual([
      'Duplicate key',
      'Duplicate key',
    ]);

    act(() => result.current.setCustomKey(result.current.custom[1].id, 'k2'));
    expect(result.current.isValid).toBe(true);
  });

  it('empty contentType/cacheControl serialize to undefined (leave-as-is semantics)', () => {
    const { result } = renderHook(runHook, { storage: null, path: null });
    expect(result.current.toPatch()).toEqual({
      contentType: undefined,
      cacheControl: undefined,
      customMetadata: {},
    });
  });

  it('save() writes through updateMetadata and re-baselines the draft', async () => {
    const storage = makeStorage('save');
    await uploadBytes(ref(storage, 'a.txt'), new Blob(['a']), {
      contentType: 'text/plain',
      customMetadata: { owner: 'alice' },
    });
    const initial = await getMetadata(ref(storage, 'a.txt'));

    const { result } = renderHook(runHook, {
      storage,
      path: 'a.txt',
      options: { initial },
    });
    act(() => result.current.setCacheControl('no-store'));
    act(() => result.current.addCustomEntry('env', 'prod'));
    expect(result.current.isDirty).toBe(true);

    let saved: unknown;
    await act(async () => {
      saved = await result.current.save();
    });

    // The returned metadata is the fresh server record.
    expect(saved).toMatchObject({
      cacheControl: 'no-store',
      contentType: 'text/plain',
      customMetadata: { owner: 'alice', env: 'prod' },
    });
    // Server truth agrees; server-set fields preserved, metageneration bumped.
    const after = await getMetadata(ref(storage, 'a.txt'));
    expect(after.cacheControl).toBe('no-store');
    expect(after.customMetadata).toEqual({ owner: 'alice', env: 'prod' });
    expect(after.size).toBe(1);
    expect(after.metageneration).toBe('2');
    // Successful save clears dirty (draft is the new baseline).
    await waitFor(() => expect(result.current.isDirty).toBe(false));
    expect(result.current.isSaving).toBe(false);
    expect(result.current.saveError).toBeUndefined();
  });

  it('row removal persists: customMetadata replaces wholesale', async () => {
    const storage = makeStorage('remove');
    await uploadBytes(ref(storage, 'a.txt'), new Blob(['a']), {
      customMetadata: { owner: 'alice', stale: 'yes' },
    });
    const initial = await getMetadata(ref(storage, 'a.txt'));
    const { result } = renderHook(runHook, {
      storage,
      path: 'a.txt',
      options: { initial },
    });

    const staleId = result.current.custom.find((e) => e.key === 'stale')!.id;
    act(() => result.current.removeCustomEntry(staleId));
    await act(async () => {
      await result.current.save();
    });

    const after = await getMetadata(ref(storage, 'a.txt'));
    expect(after.customMetadata).toEqual({ owner: 'alice' });
  });

  it('save() surfaces a typed StorageError via saveError, not a throw', async () => {
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
    const objectPath = 'b/pyric-default/o/a.txt';
    await uploadBytes(ref(authed, objectPath), new Blob(['a']));

    const anon = getStorageSandbox(sandbox.withAuth(null), { dbName });
    const { result } = renderHook(runHook, { storage: anon, path: objectPath });
    act(() => result.current.setCacheControl('no-store'));

    let saved: unknown = 'sentinel';
    await act(async () => {
      saved = await result.current.save();
    });
    expect(saved).toBeUndefined();
    expect((result.current.saveError as { code?: unknown }).code).toBe(
      'storage/unauthorized',
    );
    // Draft still dirty — nothing was committed.
    expect(result.current.isDirty).toBe(true);
  });

  it('save() refuses an invalid draft without hitting the backend', async () => {
    const storage = makeStorage('invalid');
    await uploadBytes(ref(storage, 'a.txt'), new Blob(['a']));
    const { result } = renderHook(runHook, { storage, path: 'a.txt' });

    act(() => result.current.addCustomEntry()); // empty key → invalid
    let saved: unknown = 'sentinel';
    await act(async () => {
      saved = await result.current.save();
    });
    expect(saved).toBeUndefined();
    expect(result.current.saveError?.message).toContain('validation');
    const after = await getMetadata(ref(storage, 'a.txt'));
    expect(after.metageneration).toBe('1');
  });
});
