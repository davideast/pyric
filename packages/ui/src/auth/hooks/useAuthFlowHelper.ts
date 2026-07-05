import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { Auth } from 'pyric/auth';
import {
  AuthFlowController,
  type HelperState,
  type NewIdentitySpec,
} from '../controller.js';

export interface UseAuthFlowHelperResult {
  /** Render snapshot: the in-flight request (or null) + pickable identities. */
  state: HelperState;
  /** Settle the flow with an existing identity (by uid). */
  pick: (uid: string) => void;
  /** Create + sign in as a new identity (seeds it for next time). */
  add: (spec: NewIdentitySpec) => void;
  /** Dismiss — rejects the app's sign-in promise with
   *  `auth/popup-closed-by-user` (faithful to `firebase/auth`). */
  cancel: () => void;
}

/**
 * Emulator-style sign-in helper for a sandbox `Auth` handle.
 *
 * Installs an {@link AuthFlowController} as the handle's
 * `AuthFlowResolver` for the lifetime of the calling component — the
 * analog of browser `getAuth` wiring `browserPopupRedirectResolver`.
 * While mounted, any `signInWithPopup` / `signInWithRedirect` call made
 * against `auth` parks on `state.request`; render an account-picker UI
 * (e.g. `<AuthSignInHelper>`) from `state` and settle with
 * `pick` / `add` / `cancel`.
 *
 * Install/uninstall is a paired effect, so the StrictMode double-mount
 * installs and cleanly uninstalls. Sandbox-only: the controller throws
 * `failed-precondition` if `auth` is prod-backed.
 */
export function useAuthFlowHelper(auth: Auth): UseAuthFlowHelperResult {
  const controller = useMemo(() => new AuthFlowController(auth), [auth]);

  useEffect(() => {
    controller.install();
    return () => controller.uninstall();
  }, [controller]);

  const state = useSyncExternalStore(
    useCallback((cb: () => void) => controller.subscribe(cb), [controller]),
    () => controller.snapshot(),
    () => controller.snapshot(),
  );

  const pick = useCallback((uid: string) => controller.pick(uid), [controller]);
  const add = useCallback((spec: NewIdentitySpec) => controller.add(spec), [controller]);
  const cancel = useCallback(() => controller.cancel(), [controller]);

  return { state, pick, add, cancel };
}
