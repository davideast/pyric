import { createContext, createElement, useContext, type ReactNode } from 'react';
import { sandbox as authSandbox } from 'pyric/auth';

/**
 * The sandbox auth admin ops `useAuthUsers` drives, as an INJECTABLE bundle.
 *
 * WHY (same rationale as `@pyric/ui/firestore`'s FirestoreApi): the hook defaults
 * to the in-process `pyric/auth` `sandbox` ops, but Pyric Studio's served mode
 * drives the SAME ops over a SharedWorker (a parallel client over a MessagePort).
 * Reading them from this context lets a consumer inject the worker client's fns
 * so the hook operates on the live worker user DB without knowing the backend.
 *
 * The bundle is typed to the in-process signatures; a worker bundle is adapted
 * (cast) at the Studio boundary. NOTE the worker `listUsers` is ASYNC (an RPC)
 * whereas the in-process one is sync, so `useAuthUsers` tolerates a promise (it
 * wraps the result in `Promise.resolve`).
 *
 * Default = the real `pyric/auth` sandbox ops, so every existing consumer is
 * unchanged: no provider needed unless swapping the backend.
 */
export type AuthApi = Pick<
  typeof authSandbox,
  | 'listUsers'
  | 'subscribeUsers'
  | 'createUser'
  | 'updateUser'
  | 'deleteUser'
  | 'clearUsers'
  // Sign-in provider config (S-AUTH "Sign-in providers" section). Same shape
  // as the user-DB ops above: a getter/setter plus a coarse subscription that
  // re-reads on any change. `setAuthProviderConfig` ALSO fires a
  // `provider_config_update` sandbox event, so a worker-backed bundle can ride
  // the SAME event feed `subscribeUsers` already rides instead of standing up
  // a second live channel — see `worker-live.ts`.
  | 'getAuthProviderConfig'
  | 'setAuthProviderConfig'
  | 'subscribeAuthProviderConfig'
>;

const inProcessAuthApi: AuthApi = {
  listUsers: authSandbox.listUsers,
  subscribeUsers: authSandbox.subscribeUsers,
  createUser: authSandbox.createUser,
  updateUser: authSandbox.updateUser,
  deleteUser: authSandbox.deleteUser,
  clearUsers: authSandbox.clearUsers,
  getAuthProviderConfig: authSandbox.getAuthProviderConfig,
  setAuthProviderConfig: authSandbox.setAuthProviderConfig,
  subscribeAuthProviderConfig: authSandbox.subscribeAuthProviderConfig,
};

const AuthApiContext = createContext<AuthApi>(inProcessAuthApi);

/** Read the active auth API bundle (defaults to in-process `pyric/auth`). */
export function useAuthApi(): AuthApi {
  return useContext(AuthApiContext);
}

/**
 * Provide an auth API bundle to the subtree. Pyric Studio supplies the
 * in-process bundle for dev-seed review and the SharedWorker client bundle under
 * `pyric sandbox --ui`.
 */
export function AuthApiProvider({
  value,
  children,
}: {
  value: AuthApi;
  children: ReactNode;
}) {
  return createElement(AuthApiContext.Provider, { value }, children);
}
