import * as inPage from 'pyric/auth';
import { linkWithCredential as linkWorkerCredential, unlink as unlinkWorkerUser } from '../worker/client/auth-linking.js';
import { useWorker } from './worker-runtime.js';
import { resolveServeAuthFlow } from './auth-helper-runtime.js';
import { afterPageBackend } from './page-backend-wait.js';

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

let resolvedLinkWithCredential: typeof inPage.linkWithCredential;
let resolvedUnlink: typeof inPage.unlink;
let resolvedLinkWithPopup: typeof inPage.linkWithPopup;
let resolvedLinkWithRedirect: typeof inPage.linkWithRedirect;
if (useWorker) {
  resolvedLinkWithCredential = linkWorkerCredential as unknown as typeof inPage.linkWithCredential;
  resolvedUnlink = unlinkWorkerUser as unknown as typeof inPage.unlink;
  resolvedLinkWithPopup = (user, provider, resolver) => linkProvider(user, provider, resolver, 'popup');
  resolvedLinkWithRedirect = (user, provider, resolver) => linkProvider(user, provider, resolver, 'redirect');
} else {
  resolvedLinkWithCredential = afterPageBackend(inPage.linkWithCredential);
  resolvedUnlink = afterPageBackend(inPage.unlink);
  resolvedLinkWithPopup = afterPageBackend(inPage.linkWithPopup);
  resolvedLinkWithRedirect = afterPageBackend(inPage.linkWithRedirect);
}

export const linkWithCredential: typeof inPage.linkWithCredential = resolvedLinkWithCredential;
export const unlink: typeof inPage.unlink = resolvedUnlink;
export const linkWithPopup: typeof inPage.linkWithPopup = resolvedLinkWithPopup;
export const linkWithRedirect: typeof inPage.linkWithRedirect = resolvedLinkWithRedirect;
