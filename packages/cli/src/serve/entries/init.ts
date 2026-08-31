/**
 * `/__pyric/sdk/init.js` — the script tag `pyric dev` injects into every
 * served HTML page. Pulls the shared runtime and mounts the sign-in helper.
 * In worker mode the helper reads the worker user directory and owns UI state
 * only; in fallback mode it mints credentials via `createSignInCredential`
 * so OAuth users carry real provider metadata.
 */
import {
  getAuth,
  sandbox as authSandbox,
  signOut as localSignOut,
  onAuthStateChanged as localOnAuthStateChanged,
} from 'pyric/auth';
import {
  getAuth as getWorkerAuth,
  listUsers,
  restorePortSession,
  signOut as workerSignOut,
  onAuthStateChanged as workerOnAuthStateChanged,
  setLens,
  acceptProviderCredential,
} from '../worker/client.js';
import {
  switchAllAuthUsers,
  signOutAllAuths,
  commitCredentialToAllAuths,
  getActiveAuthUser,
  subscribeToActiveAuth,
} from './auth.js';
import { sandbox } from './runtime.js';
import { useWorker, workerDb } from './worker-runtime.js';
import { ServeAuthHelper, customClaimsFromTokenClaims } from './auth-helper-core.js';
import { installServeAuthResolver } from './auth-helper-runtime.js';
import { mountAuthHelperDialog } from './auth-helper-dom.js';
import { installPyricRuntimeChip } from '../runtime/chip-install.js';
import { getPyricRuntimeStatus } from '../runtime/status.js';

const localAuth = useWorker ? null : getAuth(sandbox);
const workerAuth = useWorker && workerDb ? getWorkerAuth(workerDb) : null;
const helper = workerAuth
  ? new ServeAuthHelper({
      list: async () => (await listUsers(workerAuth)).map((user) => ({
        uid: user.uid,
        email: user.email,
        displayName: user.displayName,
        customClaims: user.customClaims,
      })),
    })
  : new ServeAuthHelper(
      {
        list: () => authSandbox.listIdentities(localAuth!),
      },
      (request) => {
        if (request.kind === 'pick') {
          return authSandbox.createSignInCredential(localAuth!, {
            providerId: request.providerId,
            uid: request.identity.uid,
          });
        }
        return authSandbox.createSignInCredential(localAuth!, {
          providerId: request.providerId,
          spec: {
            email: request.spec.email,
            displayName: request.spec.displayName,
            customClaims: request.spec.customClaims,
          },
        });
      },
    );
const resolver = helper.resolver();
installServeAuthResolver(resolver);
if (localAuth) authSandbox.setAuthFlowResolver(localAuth, resolver);

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  mountAuthHelperDialog(helper);
  installPyricRuntimeChip({
    runtime: getPyricRuntimeStatus(),
    document,
    listUsers: async () => {
      if (workerAuth) {
        return listUsers(workerAuth);
      }
      if (localAuth) {
        return authSandbox.listUsers(localAuth);
      }
      return [];
    },
    switchUser: async (uid: string) => {
      await switchAllAuthUsers(uid);
      if (workerAuth) await restorePortSession(workerAuth, uid);
      else if (localAuth) authSandbox.restoreSession(localAuth, uid);
      setLens(undefined);
    },
    signOut: async () => {
      await signOutAllAuths();
      if (workerAuth) await workerSignOut(workerAuth);
      else if (localAuth) await localSignOut(localAuth);
      setLens(undefined);
    },
    openCreateUser: async () => {
      try {
        const cred = await helper.promptCreateUser('password');
        const tokenResult = await cred.user.getIdTokenResult();
        const customClaims = customClaimsFromTokenClaims(
          (tokenResult.claims ?? {}) as Record<string, unknown>,
        );
        const identity = {
          uid: cred.user.uid,
          email: cred.user.email,
          displayName: cred.user.displayName,
          customClaims,
          providerId: 'password',
        };
        await commitCredentialToAllAuths(identity);
        if (workerAuth) await acceptProviderCredential(workerAuth, identity);
        await switchAllAuthUsers(identity.uid);
        setLens(undefined);
      } catch (err) {
        console.error('[pyric] openCreateUser error:', err);
      }
    },
    getCurrentUser: () => {
      const active = getActiveAuthUser();
      if (active) return active;
      if (workerAuth?.currentUser) {
        return {
          uid: workerAuth.currentUser.uid,
          email: workerAuth.currentUser.email,
          displayName: workerAuth.currentUser.displayName,
        };
      }
      if (localAuth?.currentUser) {
        return {
          uid: localAuth.currentUser.uid,
          email: localAuth.currentUser.email,
          displayName: localAuth.currentUser.displayName,
        };
      }
      return null;
    },
    subscribeAuth: (listener) => {
      const unsubActive = subscribeToActiveAuth((user) => {
        listener(user ? { uid: user.uid, email: user.email, displayName: user.displayName } : null);
      });
      let unsubWorker = () => {};
      if (workerAuth) {
        unsubWorker = workerOnAuthStateChanged(workerAuth, (user) => {
          listener(user ? { uid: user.uid, email: user.email, displayName: user.displayName } : null);
        });
      } else if (localAuth) {
        unsubWorker = localOnAuthStateChanged(localAuth, (user) => {
          listener(user ? { uid: user.uid, email: user.email, displayName: user.displayName } : null);
        });
      }
      return () => {
        unsubActive();
        unsubWorker();
      };
    },
  });
}

export {};
