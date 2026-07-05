/**
 * `@pyric/auth/admin` — Identity Toolkit-driven auth tooling.
 *
 * Sibling subpath to `@pyric/auth` (the modular Web-SDK adapter).
 * Control-plane surface lives here so the swap-in namespace doesn't
 * pull in Identity Toolkit REST clients for browser bundles that just
 * want `getAuth` / `signInAnonymously` / etc.
 *
 * Surface:
 *   - `getAuthTools(scope)` — programmatic API returning `AuthTools`
 *     (`generateIR`, `configureProvider`, `manageDomains`).
 *   - `createAuthAdminTools({ scope })` — `ToolHandler[]` factory for
 *     `@inbrowser/agent` / MCP wiring. Mirrors the
 *     `createRtdbAdminTools` shape.
 *   - Types: `AuthIR`, `AuthTools`, `AuthProviderId`,
 *     `AuthIRGenerationError`, the provider/domains input/result
 *     schemas.
 *
 * Per F3: every primitive takes `ProjectScope`. Per F4: callers invoke
 * `resolveToken()` per call.
 */
export { getAuthTools } from './resolver.js';
export { createAuthAdminTools } from './tools.js';
export type { AuthAdminToolDeps } from './tools.js';

export { AuthMapper } from './mapper.js';

export type {
  AuthProviderId,
  AuthIR,
  AuthTools,
} from './types.js';
export { AuthIRGenerationError } from './types.js';

export { ConfigureProviderHandler } from './provider/handler.js';
export {
  ConfigureProviderInputSchema,
  ProviderIdSchema,
} from './provider/spec.js';
export type {
  ConfigureProviderInput,
  ConfigureAuthResult,
  ProviderId,
} from './provider/spec.js';

export { ManageDomainsHandler } from './domains/handler.js';
export { ManageDomainsInputSchema } from './domains/spec.js';
export type {
  ManageDomainsInput,
  ManageDomainsResult,
} from './domains/spec.js';
