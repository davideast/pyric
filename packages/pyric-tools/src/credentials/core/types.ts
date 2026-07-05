/**
 * The isomorphic login core — contract types. Browser-safe: NO top-level
 * `node:*`. The two strategy seams (`Authorizer`, `CredentialStore`) are the same
 * seams the tests fake and the env adapters implement (node/ loopback + file,
 * browser/ popup + IndexedDB).
 */
import type { ProjectScope } from '../../deploy/scope.js';

export type { ProjectScope };

/** A Google OAuth client (a "Desktop" installed-app client). The secret is
 *  bundled, not confidential — PKCE is the real protection. */
export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
  authUri: string;
  tokenUri: string;
  baseScopes: string[];
}

/** The persisted credential. Versioned so multi-account is addable without a
 *  migration. `scopes` are the scopes Google actually GRANTED (from the token
 *  response), never what we requested. */
export interface StoredCredential {
  version: 1;
  refreshToken: string;
  /** Granted scopes (from the token response's `scope` field). */
  scopes: string[];
  clientId: string;
  projectId?: string;
  email?: string;
  obtainedAt: number;
}

/**
 * Persistence seam. The file impl (node/) writes atomically (temp + rename),
 * `0600`, and `read()` returns `null` on a missing OR corrupt file — it never
 * throws (a corrupt store reads as logged-out).
 */
export interface CredentialStore {
  read(): Promise<StoredCredential | null>;
  write(cred: StoredCredential): Promise<void>;
  clear(): Promise<void>;
}

/** What `runLogin` hands the authorizer. The authorizer owns its own redirect
 *  (a loopback port in Node, the app origin in the browser), so it builds the
 *  final URL from `buildUrl(redirectUri)` and validates `state` on the redirect. */
export interface AuthorizeRequest {
  buildUrl(redirectUri: string): string;
  state: string;
}
export interface AuthorizeResult {
  code: string;
  /** The redirect the authorizer used — the token exchange must reuse it. */
  redirectUri: string;
}

/**
 * The interactive-acquisition seam (HOW a user authorizes). Impls: loopback
 * (Node desktop), device-code (Node headless), popup/redirect (browser), fake
 * (test). Non-interactive credentials (service account, ADC, injected refresh
 * token) are `resolveScope` sources and need no authorizer.
 */
export interface Authorizer {
  authorize(req: AuthorizeRequest): Promise<AuthorizeResult>;
}

/** Google's token-endpoint response (code or refresh grant). */
export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  /** Space-delimited GRANTED scopes. */
  scope?: string;
  /** OpenID id_token (a JWT); its payload carries the user's email. */
  id_token?: string;
}
