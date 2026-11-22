import * as inPage from 'pyric/auth';
import { reauthenticateWithCredential as verifyWorkerCredential,
  reauthenticateWithProvider as verifyWorkerProvider } from '../worker/client/auth-reauthentication.js';
import type { ClientUser } from '../worker/client/auth.js';
import { useWorker } from './worker-runtime.js';
import { resolveServeAuthFlow } from './auth-helper-runtime.js';
import { afterPageBackend } from './page-backend-wait.js';

async function reauthenticateProvider(
  user: inPage.User,
  provider: inPage.AuthProvider,
  resolver: inPage.AuthFlowResolver | undefined,
  kind: 'popup' | 'redirect',
): Promise<inPage.UserCredential> {
  const request: inPage.AuthFlowRequest = { providerId: provider.providerId, authType: 'reauth' };
  const result = await resolveServeAuthFlow(request, kind, resolver);
  const verified = await verifyWorkerProvider(user as ClientUser, {
    uid: result.user.uid, providerId: result.providerId ?? provider.providerId,
  });
  return { ...verified, user };
}

let resolvedReauthenticateWithCredential: typeof inPage.reauthenticateWithCredential;
let resolvedReauthenticateWithPopup: typeof inPage.reauthenticateWithPopup;
let resolvedReauthenticateWithRedirect: typeof inPage.reauthenticateWithRedirect;
if (useWorker) {
  resolvedReauthenticateWithCredential = verifyWorkerCredential as unknown as typeof inPage.reauthenticateWithCredential;
  resolvedReauthenticateWithPopup = (user, provider, resolver) => reauthenticateProvider(user, provider, resolver, 'popup');
  resolvedReauthenticateWithRedirect = (user, provider, resolver) => reauthenticateProvider(user, provider, resolver, 'redirect');
} else {
  resolvedReauthenticateWithCredential = afterPageBackend(inPage.reauthenticateWithCredential);
  resolvedReauthenticateWithPopup = afterPageBackend(inPage.reauthenticateWithPopup);
  resolvedReauthenticateWithRedirect = afterPageBackend(inPage.reauthenticateWithRedirect);
}

export const reauthenticateWithCredential: typeof inPage.reauthenticateWithCredential = resolvedReauthenticateWithCredential;
export const reauthenticateWithPopup: typeof inPage.reauthenticateWithPopup = resolvedReauthenticateWithPopup;
export const reauthenticateWithRedirect: typeof inPage.reauthenticateWithRedirect = resolvedReauthenticateWithRedirect;
