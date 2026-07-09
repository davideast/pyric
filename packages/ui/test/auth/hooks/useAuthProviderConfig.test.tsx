/** `useAuthProviderConfig` — live sign-in provider config over the sandbox
 *  backend. DOM-free via the shared react-test-renderer harness. Mirrors
 *  `useAuthUsers.test.tsx`'s coverage shape. */
import { describe, test, expect } from 'bun:test';
import { act } from 'react-test-renderer';
import { initializeSandbox } from 'pyric/sandbox';
import { getAuth, sandbox as authSandbox, type Auth } from 'pyric/auth';
import { renderHook } from '../../helpers/render-hook.js';
import { useAuthProviderConfig } from '../../../src/auth/hooks/index.js';

function freshAuth(): Auth {
  return getAuth(initializeSandbox());
}

describe('useAuthProviderConfig', () => {
  test('lists the default config on mount (password + anonymous enabled)', () => {
    const auth = freshAuth();
    const { result, unmount } = renderHook(() => useAuthProviderConfig(auth));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeUndefined();
    expect(result.current.isEnabled('password')).toBe(true);
    expect(result.current.isEnabled('anonymous')).toBe(true);
    expect(result.current.isEnabled('google.com')).toBe(false);
    unmount();
  });

  test('setEnabled toggles a provider and the view stays live', () => {
    const auth = freshAuth();
    const { result, unmount } = renderHook(() => useAuthProviderConfig(auth));
    expect(result.current.isEnabled('google.com')).toBe(false);

    act(() => {
      result.current.setEnabled('google.com', true);
    });
    expect(result.current.isEnabled('google.com')).toBe(true);

    act(() => {
      result.current.setEnabled('password', false);
    });
    expect(result.current.isEnabled('password')).toBe(false);
    unmount();
  });

  test('external mutations (another handle, the agent) reach the view via subscribeAuthProviderConfig', () => {
    const auth = freshAuth();
    const { result, unmount } = renderHook(() => useAuthProviderConfig(auth));
    act(() => {
      authSandbox.setAuthProviderConfig(auth, 'github.com', true);
    });
    expect(result.current.isEnabled('github.com')).toBe(true);
    unmount();
  });

  test('refresh re-reads the config manually', () => {
    const auth = freshAuth();
    const { result, unmount } = renderHook(() => useAuthProviderConfig(auth));
    authSandbox.setAuthProviderConfig(auth, 'apple.com', true);
    act(() => {
      result.current.refresh();
    });
    expect(result.current.isEnabled('apple.com')).toBe(true);
    unmount();
  });

  test('unmount unsubscribes (no further re-list crashes)', () => {
    const auth = freshAuth();
    const { unmount } = renderHook(() => useAuthProviderConfig(auth));
    unmount();
    authSandbox.setAuthProviderConfig(auth, 'microsoft.com', true);
    expect(
      authSandbox.getAuthProviderConfig(auth).find((c) => c.providerId === 'microsoft.com')?.enabled,
    ).toBe(true);
  });
});
