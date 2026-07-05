import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  collection as collFn,
  doc as docFn,
  getFirestore,
  type CollectionReference,
  type DocumentReference,
} from 'pyric/firestore';
import { useReferencePicker } from '../../../src/firestore/hooks/useReferencePicker.js';
import { renderHook, act, waitFor } from '../../helpers/render-hook.js';

// One sandbox + one Firestore handle shared by every test in the
// file. `useReferencePicker` calls `doc(firestore, path)` and
// `query(coll, limit)` — both check the @pyric/firestore brand on
// the input ref. Plain `{ path, id, firestore }` literals don't
// pass that check; refs must come from the real factories. We
// initialize one sandbox + handle and reuse, so the multi-
// initializeSandbox upstream bug (flagged in M1) doesn't apply.
const sandbox = initializeSandbox();
const firestore = getFirestore(sandbox.withAuth({ uid: 'tester' }));

function realColl(id: string): CollectionReference {
  return collFn(firestore, id);
}

function realDoc(path: string): DocumentReference {
  return docFn(firestore, path);
}

describe('useReferencePicker', () => {
  it('starts at root with empty input + null reference', async () => {
    const { result } = renderHook(() =>
      useReferencePicker({
        firestore,
        listCollections: async () => [realColl('users'), realColl('posts')],
      }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.pathInput).toBe('');
    expect(result.current.reference).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.browseLocation).toEqual({ kind: 'root' });
    expect(result.current.collections.map((c) => c.id)).toEqual(['users', 'posts']);
    expect(result.current.canDrillBack).toBe(false);
  });

  it('flags an odd-segment path as invalid', async () => {
    const { result } = renderHook(() =>
      useReferencePicker({
        firestore,
        listCollections: async () => [],
      }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => {
      result.current.setPathInput('users');
    });
    expect(result.current.error).toBeDefined();
    expect(result.current.reference).toBeNull();
  });

  it('clear() resets path + browse location', async () => {
    const { result } = renderHook(() =>
      useReferencePicker({
        firestore,
        listCollections: async () => [realColl('users')],
        initialPath: 'users/alice',
      }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => {
      result.current.drillIntoCollection(realColl('users'));
    });
    expect(result.current.browseLocation.kind).toBe('collection');
    act(() => {
      result.current.clear();
    });
    expect(result.current.pathInput).toBe('');
    expect(result.current.browseLocation).toEqual({ kind: 'root' });
    expect(result.current.canDrillBack).toBe(false);
  });

  it('drillIntoCollection enables drillBack', async () => {
    const { result } = renderHook(() =>
      useReferencePicker({
        firestore,
        listCollections: async () => [realColl('users')],
      }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => {
      result.current.drillIntoCollection(realColl('users'));
    });
    expect(result.current.browseLocation.kind).toBe('collection');
    expect(result.current.canDrillBack).toBe(true);
    act(() => {
      result.current.drillBack();
    });
    expect(result.current.browseLocation).toEqual({ kind: 'root' });
    expect(result.current.canDrillBack).toBe(false);
  });

  it('drillIntoDocument fetches its subcollections', async () => {
    const aliceRef = realDoc('users/alice');
    let lastListedParent: DocumentReference | null = null;
    const { result } = renderHook(() =>
      useReferencePicker({
        firestore,
        listCollections: async (_fs, parent) => {
          lastListedParent = parent;
          if (parent == null) return [realColl('users')];
          return [realColl(`${parent.path}/posts`)];
        },
      }),
    );
    await waitFor(() => expect(result.current.collections.map((c) => c.id)).toEqual(['users']));
    act(() => {
      result.current.drillIntoDocument(aliceRef);
    });
    await waitFor(() => expect(result.current.collections.map((c) => c.id)).toEqual(['posts']));
    expect(lastListedParent).toBe(aliceRef);
  });

  it('pick(ref) updates pathInput → reference', async () => {
    const { result } = renderHook(() =>
      useReferencePicker({
        firestore,
        listCollections: async () => [],
      }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => {
      result.current.pick(realDoc('users/alice'));
    });
    expect(result.current.pathInput).toBe('users/alice');
    expect(result.current.reference?.path).toBe('users/alice');
    expect(result.current.error).toBeNull();
  });

  it('initialPath is honored on first render', async () => {
    const { result } = renderHook(() =>
      useReferencePicker({
        firestore,
        listCollections: async () => [],
        initialPath: 'users/alice',
      }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.pathInput).toBe('users/alice');
    expect(result.current.reference?.path).toBe('users/alice');
  });
});
