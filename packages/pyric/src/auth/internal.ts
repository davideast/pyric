/**
 * `pyric/auth/internal` — host-only seam for the sandbox auth backend, on the
 * `pyric/sandbox/internal` / `pyric/storage/internal` precedent.
 *
 * The default-avatar generator is the sandbox's built-in image of last resort.
 * The dev server's `/__pyric/assets/avatar/<uid>` route mounts it as the asset
 * resolver's fallback, so a served page and an in-page sandbox with no server
 * render the SAME deterministic face for a uid. `@pyric/cli` reads it through
 * this subpath rather than reaching into the package's source tree.
 *
 * **Not part of the public API.** These exports mirror no Firebase surface and
 * are never reached by application code, so the conformance census does not
 * measure them. Shape subject to change without breaking-change semantics
 * across versions.
 */
export {
  avatarSeed,
  defaultAvatarDataUri,
  defaultAvatarMint,
  defaultAvatarSvg,
} from './sandbox/default-avatar.js';
export type { AvatarMint, AvatarMintInput } from './sandbox/default-avatar.js';
export {
  isEmailSignInLink,
  resolveEmailLinkIdentity,
  sendTenantSignInLinkToEmail,
} from './email-link.js';
export { sendTenantPasswordResetEmail } from './action-codes.js';
export { effectiveSessionClaimsFor, mintCustomTokenFor, resolveCustomTokenIdentity } from './tokens.js';
export { isFederatedProviderId } from './providers.js';
export {
  decodeOidcIdTokenClaims,
  resolveOidcJwtIdentity,
  type DecodedOidcIdToken,
  type ResolveOidcJwtInput,
  type ResolvedOidcJwtIdentity,
} from './sandbox/oidc-jwt-credential.js';
export { noMockConfiguredError } from './sign-in.js';
export { SERVED_SANDBOX_HOOK } from './sandbox/driver.js';
export {
  assertMatchingTenant,
  normalizeTenantScope,
  tenantEmailKey,
} from './sandbox/tenant-isolation.js';
/** The key a page stores to resume its session after a reload (#1950). */
export { sessionKeyOf } from './sandbox/session-ledger.js';
export { assertOrRecordAuthInitOptions, recordDefaultAuthInitOptions } from './instances.js';
export {
  resolveInitializeAuthPersistence,
  resolvePersistenceMode,
  type ResolvedPersistenceConfig,
} from './sandbox/persistence-options.js';
export type { ServedSandboxHook } from './sandbox/driver.js';
export {
  applyBeforeCreateResponseToInit,
  getAuthBlockingHooks,
  hasBeforeCreateHook,
  hasBeforeSignInHook,
  makeAuthBlockingRejectionError,
  setAuthBlockingHooks,
  type AuthBlockingClientContext,
  type AuthBlockingCreateHookInput,
  type AuthBlockingCredentialContext,
  type AuthBlockingEmailHookInput,
  type AuthBlockingEmailType,
  type AuthBlockingHooks,
  type AuthBlockingProviderInfo,
  type AuthBlockingSignInHookInput,
  type AuthBlockingSmsHookInput,
  type AuthBlockingSmsType,
  type AuthBlockingUserCandidate,
  type BeforeCreateHookResult,
  type BeforeEmailHookResult,
  type BeforeSignInHookResult,
  type BeforeSmsHookResult,
} from './sandbox/blocking-hooks.js';
export {
  createBlockedAnonymousUser,
  createBlockedEmailPasswordUser,
  resolveBlockedCustomTokenIdentity,
  resolveBlockedEmailLinkIdentity,
} from './sandbox/blocking-user-creation.js';
export {
  resolveBlockedFederatedIdentity,
  resolveBlockedOidcJwtIdentity,
  type BlockedFederatedIdentityInput,
} from './sandbox/blocking-federated-creation.js';
export {
  extractBlockingCredentialContext,
  signInBlockedEmailPasswordUser,
} from './sandbox/blocking-sign-in.js';
export type { OutboundAuthSms, SendAuthSmsRequest } from './sandbox/blocking-dispatch.js';
