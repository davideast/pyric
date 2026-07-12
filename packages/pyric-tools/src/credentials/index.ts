/**
 * Public credential surface (`@pyric/cli/credentials`) for consumers that build
 * their own auth flow on the isomorphic core — notably the playground's BFF
 * server endpoints. The core (auth-url + PKCE, token exchange, scope policy) plus
 * the framework-agnostic BFF helpers. Browser-safe core; the BFF helpers are
 * server-intended but use only `fetch`.
 */
export { buildAuthUrl, pkce, randomState } from './core/authorize.js';
export { exchangeAuthCode, exchangeRefreshToken, AuthExpired } from './core/exchange.js';
export { oauthClient, GOOGLE_AUTH_URI, GOOGLE_TOKEN_URI } from './core/client.js';
export { SCOPES, BASE_SCOPES, missingScope } from './core/scopes.js';
export { startAuth, completeAuth, refreshAccess } from './server/bff.js';
export type { OAuthClient, StoredCredential, TokenResponse } from './core/types.js';
