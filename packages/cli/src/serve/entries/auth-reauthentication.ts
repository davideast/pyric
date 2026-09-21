import * as inPage from 'pyric/auth';
import { reauthenticateWithCredential as verifyWorkerCredential,
  reauthenticateWithProvider as verifyWorkerProvider } from '../worker/client/auth-reauthentication.js';
import type { ClientUser } from '../worker/client/auth.js';
import { useWorker } from './worker-runtime.js';
import { resolveServeAuthFlow } from './auth-helper-runtime.js';

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

export const reauthenticateWithCredential = (useWorker ? verifyWorkerCredential : inPage.reauthenticateWithCredential) as typeof inPage.reauthenticateWithCredential;
export const reauthenticateWithPopup: typeof inPage.reauthenticateWithPopup = useWorker
  ? (user, provider, resolver) => reauthenticateProvider(user, provider, resolver, 'popup')
  : inPage.reauthenticateWithPopup;
export const reauthenticateWithRedirect: typeof inPage.reauthenticateWithRedirect = useWorker
  ? (user, provider, resolver) => reauthenticateProvider(user, provider, resolver, 'redirect')
  : inPage.reauthenticateWithRedirect;
