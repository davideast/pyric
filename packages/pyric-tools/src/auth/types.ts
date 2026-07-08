/**
 * Types for the auth control-plane surface (`pyric/auth/admin`).
 *
 * Pairs with mapper.ts +
 * resolver.ts + provider/ + domains/ — the Identity Toolkit-driven
 * tooling that's distinct from the modular Web-SDK adapter that
 * pyric/auth's root entry provides.
 */

// 1. Strict provider-id union to prevent hallucinations.
export type AuthProviderId =
  | 'password'
  | 'phone'
  | 'anonymous'
  | 'google.com'
  | 'github.com'
  | 'apple.com'
  | 'microsoft.com';

// 2. The target IR payload returned by `generateIR()`.
export interface AuthIR {
  service: "authentication";
  enabledProviders: AuthProviderId[];
  settings: {
    allowPasswordSignup: boolean;
    enableAnonymousUser: boolean;
  };
}

// 3. Service analyzer surface (mirrors `getAuth(app)` in shape).
export interface AuthTools {
  /**
   * Fetches raw configurations and maps them to the strict AuthIR schema.
   * MUST throw AuthIRGenerationError on failure.
   */
  generateIR(): Promise<AuthIR>;

  /**
   * Enable or disable an auth provider. Supports anonymous, email, phone, and google.
   */
  configureProvider(input: import('./provider/spec.js').ConfigureProviderInput): Promise<import('./provider/spec.js').ConfigureAuthResult>;

  /**
   * Add, remove, or list authorized domains for OAuth redirects.
   */
  manageDomains(input: import('./domains/spec.js').ManageDomainsInput): Promise<import('./domains/spec.js').ManageDomainsResult>;
}

// 4. Explicit error boundary for agent self-correction.
export class AuthIRGenerationError extends Error {
  constructor(public readonly missingField: string, message: string) {
    super(`[AuthIRGenerationError] Failed to map field '${missingField}': ${message}`);
  }
}
