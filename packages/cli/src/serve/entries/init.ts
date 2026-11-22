/**
 * `/__pyric/sdk/init.js` -- the script tag `pyric dev` injects into every
 * served HTML page. Pulls the shared runtime and mounts the sign-in helper.
 * In worker mode the helper reads the worker user directory and owns UI state
 * only; in fallback mode it mints credentials via `createSignInCredential`
 * so OAuth users carry real provider metadata.
 */
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { configureListenerAttribution } from 'pyric/sandbox/internal';
import {
  installPyricRuntimeChip,
  type InstallPyricRuntimeChipOptions,
} from '../runtime/chip-install.js';
import { healthLiveStatus } from '../runtime/chip-live-status.js';
import { projectRuntimeIdentity } from '../runtime/identity.js';
import { createIndexConfigClient } from '../runtime/index-config-client.js';
import { sandboxEventSource } from '../runtime/listener-event-source.js';
import { pageLiveIdentity } from '../runtime/live-identity.js';
import { getPyricRuntimeStatus } from '../runtime/status.js';
import { createThresholdConfigClient } from '../runtime/threshold-config-client.js';
import { getAuth as getWorkerAuth, listUsers, setLens } from '../worker/client.js';
import {
  commitCredentialToAllAuths,
  getActiveAuthUser,
  registerActiveAuth,
  signOutAllAuths,
  subscribeToActiveAuth,
  switchAllAuthUsers,
} from './active-auth.js';
import { sandbox } from './app-backend.js';
import { ServeAuthHelper, helperCustomClaims } from './auth-helper-core.js';
import { mountAuthHelperDialog } from './auth-helper-dom.js';
import { installServeAuthResolver } from './auth-helper-runtime.js';
import { installAvatarUpgrades } from './avatar-upgrade.js';
import { initPayload, logInitPayloadFailure } from './init-payload.js';
import { useWorker, workerDb } from './worker-runtime.js';

function createPageAuthHelper(
  workerAuth: ReturnType<typeof getWorkerAuth> | null,
  localAuth: ReturnType<typeof getAuth> | null,
): ServeAuthHelper {
  if (workerAuth !== null) {
    return new ServeAuthHelper({
      list: async () =>
        (await listUsers(workerAuth)).map(user => ({
          uid: user.uid,
          email: user.email,
          displayName: user.displayName,
          // Boundary map: the stored record's `photoUrl` becomes the picker
          // identity's `photoURL`, so re-picking an identity hands its existing
          // photo back to `auth.acceptIdentity`.
          photoURL: user.photoUrl,
          isAnonymous: user.isAnonymous,
          providerUserInfo: user.providerUserInfo,
          customClaims: user.customClaims,
        })),
    });
  }
  return new ServeAuthHelper(
    {
      list: () => {
        if (localAuth === null) return [];
        return authSandbox.listIdentities(localAuth);
      },
    },
    request => {
      const targetAuth = localAuth ?? getAuth(sandbox);
      if (request.kind === 'pick') {
        return authSandbox.createSignInCredential(targetAuth, {
          providerId: request.providerId,
          uid: request.identity.uid,
        });
      }
      return authSandbox.createSignInCredential(targetAuth, {
        providerId: request.providerId,
        spec: {
          email: request.spec.email,
          displayName: request.spec.displayName,
          // Boundary map: helper `photoURL` becomes the backend spec's
          // `photoUrl`.
          photoUrl: request.spec.photoURL,
          customClaims: request.spec.customClaims,
        },
      });
    },
  );
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  // In live mode, follows the production user the app's own Auth signs in,
  // in page memory only. Outside live mode no Auth reaches it.
  pageLiveIdentity();
  const localAuth = useWorker ? null : getAuth(sandbox);
  const workerAuth = useWorker && workerDb ? getWorkerAuth(workerDb) : null;
  if (workerAuth) registerActiveAuth(workerAuth);
  if (localAuth) registerActiveAuth(localAuth);
  const helper = createPageAuthHelper(workerAuth, localAuth);
  const resolver = helper.resolver();
  installServeAuthResolver(resolver);
  if (localAuth) authSandbox.setAuthFlowResolver(localAuth, resolver);

  mountAuthHelperDialog(helper);
  // A slow avatar source finishes after the browser already painted a
  // placeholder. This page-level listener swaps in the finished image, so
  // application code stays `<img src={user.photoURL}>` with nothing to poll.
  // Not awaited: nothing below depends on the payload. A refused payload
  // reaches the app through the calls it makes, so here it is only logged.
  void initPayload.then(
    payload => installAvatarUpgrades(payload?.avatarUpgrades === true),
    logInitPayloadFailure,
  );
  // A served page is a development host whatever the app's bundle says: the
  // template's served build is a Vite production build, which folds the
  // bundled-production check to true and would leave listener attribution off.
  configureListenerAttribution('on');

  const runtime = getPyricRuntimeStatus();
  const settledInit = initPayload.catch(() => null);
  let pageFetch: typeof fetch | undefined;
  if (typeof window.fetch === 'function') {
    pageFetch = window.fetch.bind(window);
  }
  const rawLiveStatus = healthLiveStatus(document, restart =>
    runtime.reportHostRestarted(restart),
  );
  const liveStatus = async () => {
    const payload = await settledInit;
    if (payload === null || payload.remotePeer === true) return null;
    return rawLiveStatus();
  };

  const chipOptions: InstallPyricRuntimeChipOptions = {
    runtime,
    document,
    listenerEvents: sandboxEventSource({ workerDb, sandbox }),
    liveStatus,
    identity: {
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
        setLens(undefined);
      },
      signOut: async () => {
        await signOutAllAuths();
        setLens(undefined);
      },
      openCreateUser: async () => {
        try {
          const cred = await helper.promptCreateUser('password');
          const customClaims = helperCustomClaims(cred);
          const identity = {
            uid: cred.user.uid,
            email: cred.user.email,
            displayName: cred.user.displayName,
            photoURL: cred.user.photoURL,
            customClaims,
            providerId: 'password',
          };
          await commitCredentialToAllAuths(identity);
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
          return projectRuntimeIdentity(workerAuth.currentUser);
        }
        if (localAuth?.currentUser) {
          return projectRuntimeIdentity(localAuth.currentUser);
        }
        return null;
      },
      subscribeAuth: listener => {
        const unsubActive = subscribeToActiveAuth(user => {
          listener(projectRuntimeIdentity(user));
        });
        return unsubActive;
      },
    },
  };
  if (pageFetch !== undefined) {
    chipOptions.indexConfig = createIndexConfigClient(pageFetch, { init: settledInit });
    const isHttpPage = /^https?:$/.test(window.location?.protocol ?? '');
    if (isHttpPage) {
      chipOptions.thresholdConfig = createThresholdConfigClient(pageFetch, { init: settledInit });
    }
  }
  installPyricRuntimeChip(chipOptions);
}

export {};
