/** `useAuthUsers` — live list + filter + CRUD over the sandbox user DB.
 *  DOM-free via the shared react-test-renderer harness. */
import { describe, test, expect } from 'bun:test';
import { act } from 'react-test-renderer';
import { initializeSandbox } from 'pyric/sandbox';
import { getAuth, sandbox as authSandbox, type Auth } from 'pyric/auth';
import { renderHook } from '../../helpers/render-hook.js';
import { useAuthUsers } from '../../../src/auth/hooks/index.js';

function freshAuth(): Auth {
  return getAuth(initializeSandbox());
}

describe('useAuthUsers', () => {
  test('lists seeded users on mount', () => {
    const auth = freshAuth();
    authSandbox.seedUsers(auth, [
      { uid: 'u1', email: 'a@example.com', password: 'pw-aaaa' },
      { uid: 'u2', email: 'b@example.com', password: 'pw-bbbb' },
    ]);
    const { result, unmount } = renderHook(() => useAuthUsers(auth));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeUndefined();
    expect(result.current.users.map((u) => u.uid).sort()).toEqual(['u1', 'u2']);
    expect(result.current.totalCount).toBe(2);
    unmount();
  });

  test('createUser/updateUser/deleteUser mutate and the list stays live', () => {
    const auth = freshAuth();
    const { result, unmount } = renderHook(() => useAuthUsers(auth));
    expect(result.current.users).toEqual([]);

    act(() => {
      result.current.createUser({ uid: 'u1', email: 'a@example.com', displayName: 'A' });
    });
    expect(result.current.users.map((u) => u.uid)).toEqual(['u1']);

    act(() => {
      result.current.updateUser('u1', { displayName: 'A2', disabled: true });
    });
    expect(result.current.users[0]!.displayName).toBe('A2');
    expect(result.current.users[0]!.disabled).toBe(true);

    act(() => {
      result.current.deleteUser('u1');
    });
    expect(result.current.users).toEqual([]);
    unmount();
  });

  test('external mutations (agent/app) reach the view via subscribeUsers', () => {
    const auth = freshAuth();
    const { result, unmount } = renderHook(() => useAuthUsers(auth));
    act(() => {
      authSandbox.seedUsers(auth, [{ uid: 'ext', email: 'ext@example.com', password: 'pw-eeee' }]);
    });
    expect(result.current.users.map((u) => u.uid)).toEqual(['ext']);
    unmount();
  });

  test('filter matches uid, email, displayName case-insensitively; totalCount unfiltered', () => {
    const auth = freshAuth();
    authSandbox.seedUsers(auth, [
      { uid: 'alpha', email: 'alice@example.com', password: 'pw-aaaa', displayName: 'Alice' },
      { uid: 'beta', email: 'bob@example.com', password: 'pw-bbbb', displayName: 'Bob' },
    ]);
    const { result, unmount } = renderHook(() => useAuthUsers(auth));

    act(() => result.current.setFilter('ALICE'));
    expect(result.current.users.map((u) => u.uid)).toEqual(['alpha']);
    expect(result.current.totalCount).toBe(2);

    act(() => result.current.setFilter('bet'));
    expect(result.current.users.map((u) => u.uid)).toEqual(['beta']);

    act(() => result.current.setFilter('nobody'));
    expect(result.current.users).toEqual([]);

    act(() => result.current.setFilter(''));
    expect(result.current.users.length).toBe(2);
    unmount();
  });

  test('clearUsers empties the DB', () => {
    const auth = freshAuth();
    authSandbox.seedUsers(auth, [{ uid: 'u1', email: 'a@example.com', password: 'pw-aaaa' }]);
    const { result, unmount } = renderHook(() => useAuthUsers(auth));
    expect(result.current.totalCount).toBe(1);
    act(() => result.current.clearUsers());
    expect(result.current.users).toEqual([]);
    expect(result.current.totalCount).toBe(0);
    unmount();
  });

  test('mutation errors throw to the caller (uid collision)', () => {
    const auth = freshAuth();
    const { result, unmount } = renderHook(() => useAuthUsers(auth));
    act(() => {
      result.current.createUser({ uid: 'dup', email: 'a@example.com' });
    });
    expect(() => result.current.createUser({ uid: 'dup', email: 'b@example.com' })).toThrow();
    unmount();
  });

  test('unmount unsubscribes (no further re-list crashes)', () => {
    const auth = freshAuth();
    const { unmount } = renderHook(() => useAuthUsers(auth));
    unmount();
    // mutating after unmount must not throw via a stale listener
    authSandbox.seedUsers(auth, [{ uid: 'late', email: 'late@example.com', password: 'pw-llll' }]);
    expect(authSandbox.listUsers(auth).length).toBe(1);
  });
});
