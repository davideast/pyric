/** Shared resolver slot connecting the injected init entry to firebase/auth. */
import type { AuthFlowRequest, AuthFlowResolver, UserCredential } from 'pyric/auth';

let resolver: AuthFlowResolver | null = null;

export function installServeAuthResolver(next: AuthFlowResolver): void {
  resolver = next;
}

export function resolveServeAuthFlow(
  request: AuthFlowRequest,
  kind: 'popup' | 'redirect',
): Promise<UserCredential> {
  if (!resolver) {
    return Promise.reject(
      new Error('pyric sandbox provider helper is not initialized; load /__pyric/sdk/init.js first'),
    );
  }
  return kind === 'popup' ? resolver.openPopup(request) : resolver.openRedirect(request);
}
