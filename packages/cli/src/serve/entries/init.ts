/**
 * `/__pyric/sdk/init.js` — the script tag `pyric dev` injects into every
 * served HTML page. Pulls the shared runtime and mounts the sign-in helper.
 * In worker mode the helper reads the worker user directory and owns UI state
 * only; in fallback mode it adapts the page sandbox's Auth store.
 */
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import {
  getAuth as getWorkerAuth,
  listUsers,
} from '../worker/client.js';
import { sandbox } from './runtime.js';
import { useWorker, workerDb } from './worker-runtime.js';
import { ServeAuthHelper } from './auth-helper-core.js';
import { installServeAuthResolver } from './auth-helper-runtime.js';
import { mountAuthHelperDialog } from './auth-helper-dom.js';

const localAuth = useWorker ? null : getAuth(sandbox);
const workerAuth = useWorker && workerDb ? getWorkerAuth(workerDb) : null;
const helper = new ServeAuthHelper(
  workerAuth
    ? {
        list: async () => (await listUsers(workerAuth)).map((user) => ({
          uid: user.uid,
          email: user.email,
          displayName: user.displayName,
          customClaims: user.customClaims,
        })),
      }
    : {
        list: () => authSandbox.listIdentities(localAuth!),
        add: (identity) => authSandbox.seedUsers(localAuth!, [{
          uid: identity.uid,
          email: identity.email ?? '',
          password: '__pyric_popup_no_password__',
          displayName: identity.displayName ?? undefined,
          customClaims: identity.customClaims,
        }]),
      },
);
const resolver = helper.resolver();
installServeAuthResolver(resolver);
if (localAuth) authSandbox.setAuthFlowResolver(localAuth, resolver);
mountAuthHelperDialog(helper);

export {};
