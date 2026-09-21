import * as inPage from 'pyric/auth';
import { linkWithCredential as linkWorkerCredential, unlink as unlinkWorkerUser } from '../worker/client/auth-linking.js';
import { useWorker } from './worker-runtime.js';
import { resolveServeAuthFlow } from './auth-helper-runtime.js';

/** The picker resolves a provider; the host links it to the original user. */
async function linkProvider(
  user: inPage.User,
  provider: inPage.AuthProvider,
  resolver: inPage.AuthFlowResolver | undefined,
  kind: 'popup' | 'redirect',
): Promise<inPage.UserCredential> {
  const request: inPage.AuthFlowRequest = { providerId: provider.providerId, authType: 'link' };
  const result = await resolveServeAuthFlow(request, kind, resolver);
  const providerId = result.providerId ?? provider.providerId;
  const credential = new inPage.AuthCredential(providerId, providerId);
  return linkWithCredential(user, credential);
}

export const linkWithCredential = (useWorker ? linkWorkerCredential : inPage.linkWithCredential) as typeof inPage.linkWithCredential;
export const unlink = (useWorker ? unlinkWorkerUser : inPage.unlink) as typeof inPage.unlink;
export const linkWithPopup: typeof inPage.linkWithPopup = useWorker
  ? (user, provider, resolver) => linkProvider(user, provider, resolver, 'popup')
  : inPage.linkWithPopup;
export const linkWithRedirect: typeof inPage.linkWithRedirect = useWorker
  ? (user, provider, resolver) => linkProvider(user, provider, resolver, 'redirect')
  : inPage.linkWithRedirect;
