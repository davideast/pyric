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

  subscribeAuthProviderConfig(auth: Auth, callback: () => void): Unsubscribe {
    return requireSandbox(auth).backend.subscribeProviderConfig(callback);
  },
};
