/**
 * Which CORS proxy a git request may use, given whether it carries the
 * GitHub token.
 *
 * github.com serves no CORS headers on its smart-HTTP endpoints, so the
 * browser reaches it through a proxy. A proxy sees every header it
 * forwards, including the Basic credential built from the token. The
 * public proxy run for isomorphic-git is not under this app's control, so
 * a token must never travel through it. Requests that carry a token need
 * a proxy the deployment configures (`PUBLIC_GIT_CORS_PROXY`); anonymous
 * requests (public clones) may still use the public one.
 */

export const PUBLIC_CORS_PROXY = 'https://cors.isomorphic-git.org';

export class CorsProxyRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorsProxyRefusedError';
  }
}

/** The deployment's own proxy, or undefined when none is configured. */
export function configuredCorsProxy(): string | undefined {
  const raw = (import.meta.env?.PUBLIC_GIT_CORS_PROXY as string | undefined)?.trim();
  return raw ? raw : undefined;
}

export function isPublicCorsProxy(proxy: string): boolean {
  try {
    return new URL(proxy).hostname.toLowerCase() === new URL(PUBLIC_CORS_PROXY).hostname;
  } catch {
    return false;
  }
}

/**
 * Proxy for a request that carries the GitHub token. An explicit empty
 * string means no proxy (a direct request). Throws when the choice would
 * send the token through the public proxy, or when no proxy is configured.
 */
export function corsProxyForCredentials(explicit?: string): string {
  const proxy = explicit ?? configuredCorsProxy();
  if (proxy === undefined) {
    throw new CorsProxyRefusedError(
      'No git CORS proxy is configured, and the GitHub token is not sent through the public ' +
        'proxy. Set PUBLIC_GIT_CORS_PROXY to a proxy you run.',
    );
  }
  if (proxy !== '' && isPublicCorsProxy(proxy)) {
    throw new CorsProxyRefusedError(
      'The GitHub token is not sent through the public CORS proxy. Use a proxy you run ' +
        '(PUBLIC_GIT_CORS_PROXY).',
    );
  }
  return proxy;
}

/**
 * Proxy for a request that may be anonymous. Falls back to the public
 * proxy when none is configured; pair with {@link authForProxy} so a
 * credential challenge is refused instead of answered through it.
 */
export function corsProxyForOptionalCredentials(explicit?: string): string {
  return explicit ?? configuredCorsProxy() ?? PUBLIC_CORS_PROXY;
}

export interface BasicCredentials {
  username: string;
  password: string;
}

/**
 * `onAuth` callback that answers a credential challenge only when the
 * request does not go through the public proxy.
 */
export function authForProxy(
  proxy: string,
  credentials: () => Promise<BasicCredentials>,
): () => Promise<BasicCredentials> {
  return async () => {
    if (proxy !== '' && isPublicCorsProxy(proxy)) {
      throw new CorsProxyRefusedError(
        'This repository needs the GitHub token, which is not sent through the public CORS ' +
          'proxy. Set PUBLIC_GIT_CORS_PROXY to a proxy you run.',
      );
    }
    return credentials();
  };
}
