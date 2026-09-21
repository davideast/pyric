/** Shared resolver slot connecting the injected init entry to firebase/auth. */
import type { AuthFlowRequest, AuthFlowResolver, UserCredential } from 'pyric/auth';

let resolver: AuthFlowResolver | null = null;

export function installServeAuthResolver(next: AuthFlowResolver): void {
  resolver = next;
}

export function resolveServeAuthFlow(
  request: AuthFlowRequest,
  kind: 'popup' | 'redirect',
  perCall?: AuthFlowResolver,
): Promise<UserCredential> {
  const selected = perCall ?? resolver;
  const isUnavailable = selected === null;
  if (isUnavailable) {
    return Promise.reject(
      new Error('pyric sandbox provider helper is not initialized; load /__pyric/sdk/init.js first'),
    );
  }
  const isPopup = kind === 'popup';
  return isPopup ? selected.openPopup(request) : selected.openRedirect(request);
}
