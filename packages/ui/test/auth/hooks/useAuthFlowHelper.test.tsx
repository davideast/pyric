/** `useAuthFlowHelper` — resolver lifecycle + snapshot plumbing.
 *  DOM-free via the shared react-test-renderer harness. */
import { describe, test, expect } from 'bun:test';
import { act } from 'react-test-renderer';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  type Auth,
} from 'pyric/auth';
import { renderHook } from '../../helpers/render-hook.js';
import { useAuthFlowHelper } from '../../../src/auth/hooks/index.js';

function freshAuth(): Auth {
  return getAuth(initializeSandbox());
}

describe('useAuthFlowHelper', () => {
  test('mount installs the resolver: popup parks on state.request', async () => {
    const auth = freshAuth();
    const { result, unmount } = renderHook(() => useAuthFlowHelper(auth));
    expect(result.current.state.request).toBeNull();

    let p!: Promise<unknown>;
    act(() => {
      p = signInWithPopup(auth, new GoogleAuthProvider());
      p.catch(() => {}); // settled below; avoid unhandled rejection noise
    });
    expect(result.current.state.request?.providerId).toBe('google.com');

    act(() => result.current.cancel());
    await expect(p).rejects.toMatchObject({ code: 'auth/popup-closed-by-user' });
    expect(result.current.state.request).toBeNull();
    unmount();
  });

  test('add() resolves the app promise and the identity becomes pickable', async () => {
    const auth = freshAuth();
    const { result, unmount } = renderHook(() => useAuthFlowHelper(auth));

    let p!: Promise<{ user: { email: string | null } }>;
    act(() => {
      p = signInWithPopup(auth, new GoogleAuthProvider());
    });
    act(() => result.current.add({ email: 'hook@example.com', customClaims: { admin: true } }));
    const cred = await p;
    expect(cred.user.email).toBe('hook@example.com');

    // re-render reflects the seeded identity in the picker list
    expect(result.current.state.identities.some((i) => i.email === 'hook@example.com')).toBe(true);

    let p2!: Promise<{ user: { email: string | null } }>;
    act(() => {
      p2 = signInWithPopup(auth, new GoogleAuthProvider());
    });
    const uid = result.current.state.identities.find((i) => i.email === 'hook@example.com')!.uid;
    act(() => result.current.pick(uid));
    expect((await p2).user.email).toBe('hook@example.com');
    unmount();
  });

  test('unmount uninstalls the resolver (paired effect)', async () => {
    const auth = freshAuth();
    const { unmount } = renderHook(() => useAuthFlowHelper(auth));
    unmount();
    // With the resolver cleared, the SDK falls back to its faithful default.
    await expect(signInWithPopup(auth, new GoogleAuthProvider())).rejects.toMatchObject({
      code: 'auth/argument-error',
    });
  });

  test('changing the auth handle re-targets the resolver', async () => {
    const auth1 = freshAuth();
    const auth2 = freshAuth();
    const { result, rerender, unmount } = renderHook(
      ({ auth }: { auth: Auth }) => useAuthFlowHelper(auth),
      { auth: auth1 },
    );

    rerender({ auth: auth2 });

    // old handle: resolver uninstalled → faithful default error
    await expect(signInWithPopup(auth1, new GoogleAuthProvider())).rejects.toMatchObject({
      code: 'auth/argument-error',
    });

    // new handle: parks on the helper
    let p!: Promise<unknown>;
    act(() => {
      p = signInWithPopup(auth2, new GoogleAuthProvider());
      p.catch(() => {});
    });
    expect(result.current.state.request?.providerId).toBe('google.com');
    act(() => result.current.cancel());
    await expect(p).rejects.toMatchObject({ code: 'auth/popup-closed-by-user' });
    unmount();
  });
});
