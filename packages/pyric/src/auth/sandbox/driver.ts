/** Pyric-only Auth driver for fixtures, host UI, and worker administration. */
import { SandboxError } from 'pyric/sandbox';
import type { AuthActionCode, AuthMailResolver, OutboundAuthMail } from '../sandbox-auth-flow.js';
import type {
  AuthUserRecord,
  CreateUserRequest,
  MintSessionRequest,
  MintedSession,
  SeedUser,
  SignInIdentitySpec,
  UpdateUserRequest,
} from '../sandbox-backend.js';
import { targetOf, type SandboxTarget } from '../target.js';
import type { AvatarMint } from './default-avatar.js';
import type {
  Auth,
  AuthFlowResolver,
  Unsubscribe,
  User,
  UserCredential,
} from '../types.js';

function requireSandbox(auth: Auth): SandboxTarget {
  return targetOf(auth);
}

export const sandbox = {
  setUser(auth: Auth, user: User | null): void {
    requireSandbox(auth).backend.setCurrentUser(user);
  },

  setAuthFlowResolver(auth: Auth, resolver: AuthFlowResolver | null): void {
    requireSandbox(auth).backend.setResolver(resolver);
  },

  setAuthMailResolver(auth: Auth, resolver: AuthMailResolver | null): void {
    requireSandbox(auth).backend.setMailResolver(resolver);
  },

  takeAuthMail(auth: Auth, email?: string): OutboundAuthMail | null {
    return requireSandbox(auth).backend.takeMail(email);
  },

  listAuthMail(auth: Auth): OutboundAuthMail[] {
    return requireSandbox(auth).backend.listMail();
  },

  mockActionCode(auth: Auth, code: string, spec: AuthActionCode): void {
    requireSandbox(auth).backend.stageActionCode(code, spec);
  },

  listIdentities(auth: Auth) {
    return requireSandbox(auth).backend.listIdentities();
  },

  createSignInCredential(
    auth: Auth,
    request:
      | { providerId: string; uid: string }
      | { providerId: string; spec: SignInIdentitySpec },
  ): UserCredential {
    return requireSandbox(auth).backend.createSignInCredential(request);
  },

  mockSignInResult(auth: Auth, result: UserCredential): void {
    const providerId = result.providerId;
    if (!providerId) {
      throw new SandboxError(
        'invalid-argument',
        'sandbox.mockSignInResult: result.providerId is required so the next signInWithPopup / signInWithCredential call can match.',
      );
    }
    requireSandbox(auth).backend.setMockResult(providerId, result);
  },

  seedUsers(auth: Auth, users: ReadonlyArray<SeedUser>): void {
    requireSandbox(auth).backend.seedUsers(users);
  },

  exportUsers(auth: Auth): SeedUser[] {
    return requireSandbox(auth).backend.exportUsers();
  },

  restoreSession(auth: Auth, uid: string): User {
    return requireSandbox(auth).backend.restoreSession(uid);
  },

  mintSession(auth: Auth, request: MintSessionRequest): MintedSession {
    return requireSandbox(auth).backend.mintDetachedSession(request);
  },

  /**
   * The provider the app session signed in through — `password`,
   * `anonymous`, `custom`, or a federated provider id such as `google.com`.
   * The same value `IdTokenResult.signInProvider` carries, so a reporter that
   * labels a session keeps no second copy of it. `null` when signed out.
   */
  signInProvider(auth: Auth): string | null {
    return requireSandbox(auth).backend.getCurrentSignInProvider();
  },

  listUsers(auth: Auth): AuthUserRecord[] {
    return requireSandbox(auth).backend.listUsers();
  },

  createUser(auth: Auth, request: CreateUserRequest): AuthUserRecord {
    return requireSandbox(auth).backend.createUser(request);
  },

  updateUser(auth: Auth, uid: string, update: UpdateUserRequest): AuthUserRecord {
    return requireSandbox(auth).backend.updateUser(uid, update);
  },

  updateProfile(
    auth: Auth,
    uid: string,
    profile: { displayName?: string | null; photoURL?: string | null },
  ): AuthUserRecord {
    return requireSandbox(auth).backend.updateProfileByUid(uid, profile);
  },

  deleteUser(auth: Auth, uid: string): void {
    requireSandbox(auth).backend.deleteUser(uid);
  },

  clearUsers(auth: Auth): void {
    requireSandbox(auth).backend.clearUsers();
  },

  subscribeUsers(auth: Auth, callback: () => void): Unsubscribe {
    return requireSandbox(auth).backend.subscribeUsers(callback);
  },

  /**
   * Which sign-in providers are enabled, keyed by provider id.
   *
   * The whole-state form, beside {@link getAuthProviderConfig}'s listing: it
   * is what a capture writes down and what {@link restoreProviderConfig} takes
   * back, so a state capture reaches the account store through this namespace
   * rather than through the backend handle.
   */
  exportProviderConfig(auth: Auth): Record<string, boolean> {
    return requireSandbox(auth).backend.exportProviderConfig();
  },

  /** Replace the provider configuration with exactly the one given. */
  restoreProviderConfig(auth: Auth, config: Record<string, boolean>): void {
    requireSandbox(auth).backend.restoreProviderConfig(config);
  },

  getAuthProviderConfig(auth: Auth): Array<{ providerId: string; enabled: boolean }> {
    return requireSandbox(auth).backend.listProviderConfig();
  },

  setAuthProviderConfig(auth: Auth, providerId: string, enabled: boolean): void {
    requireSandbox(auth).backend.setProviderConfig(providerId, enabled);
  },

  assertAuthProviderEnabled(auth: Auth, providerId: string): void {
    requireSandbox(auth).backend.assertProviderEnabled(providerId);
  },

  delegateProviderEnforcement(auth: Auth, delegated: boolean): void {
    requireSandbox(auth).backend.setProviderEnforcementDelegated(delegated);
  },

  /**
   * Replace the mint that assigns a default `photoURL` to federated-provider
   * users at creation. The built-in mint returns a deterministic SVG data URI;
   * a served host installs one that returns its avatar route, and a host with
   * avatars turned off installs `() => null` for Firebase's own no-photo
   * behaviour. Install it during boot: the minted value is stored on each
   * record as it is created.
   */
  setAvatarMint(auth: Auth, mint: AvatarMint): void {
    requireSandbox(auth).backend.setAvatarMint(mint);
  },

  subscribeAuthProviderConfig(auth: Auth, callback: () => void): Unsubscribe {
    return requireSandbox(auth).backend.subscribeProviderConfig(callback);
  },
};
