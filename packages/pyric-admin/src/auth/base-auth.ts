/**
 * Common parent runtime class for `pyric-admin/auth` handles
 * (`firebase-admin/auth` `BaseAuth`, v13.10.0).
 */
import type {
  BaseAuthDelegate,
  CreateRequest,
  DecodedIdToken,
  ListUsersResult,
  UpdateRequest,
} from './types.js';
import type { UserRecord } from './user-record.js';

export class BaseAuth {
  protected readonly delegate: BaseAuthDelegate;
  [key: string]: unknown;

  constructor(delegate: BaseAuthDelegate) {
    this.delegate = delegate;
  }

  createCustomToken(uid: string, developerClaims?: object): Promise<string> {
    return this.delegate.createCustomToken(uid, developerClaims);
  }

  verifyIdToken(idToken: string, checkRevoked?: boolean): Promise<DecodedIdToken> {
    return this.delegate.verifyIdToken(idToken, checkRevoked);
  }

  createUser(properties: CreateRequest): Promise<UserRecord> {
    return this.delegate.createUser(properties);
  }

  getUser(uid: string): Promise<UserRecord> {
    return this.delegate.getUser(uid);
  }

  getUserByEmail(email: string): Promise<UserRecord> {
    return this.delegate.getUserByEmail(email);
  }

  deleteUser(uid: string): Promise<void> {
    return this.delegate.deleteUser(uid);
  }

  setCustomUserClaims(uid: string, customUserClaims: object | null): Promise<void> {
    return this.delegate.setCustomUserClaims(uid, customUserClaims);
  }

  revokeRefreshTokens(uid: string): Promise<void> {
    return this.delegate.revokeRefreshTokens(uid);
  }

  updateUser(uid: string, properties: UpdateRequest): Promise<UserRecord> {
    return this.delegate.updateUser(uid, properties);
  }

  listUsers(maxResults?: number, pageToken?: string): Promise<ListUsersResult> {
    return this.delegate.listUsers(maxResults, pageToken);
  }

  getUserByPhoneNumber(phoneNumber?: unknown): Promise<UserRecord> {
    return this.delegate.getUserByPhoneNumber(phoneNumber);
  }

  getUserByProviderUid(providerId?: unknown, uid?: unknown): Promise<UserRecord> {
    return this.delegate.getUserByProviderUid(providerId, uid);
  }

  getUsers(identifiers?: unknown): Promise<unknown> {
    return this.delegate.getUsers(identifiers);
  }

  deleteUsers(uids?: unknown): Promise<unknown> {
    return this.delegate.deleteUsers(uids);
  }

  importUsers(users?: unknown, options?: unknown): Promise<unknown> {
    return this.delegate.importUsers(users, options);
  }

  createSessionCookie(idToken?: unknown, sessionCookieOptions?: unknown): Promise<string> {
    return this.delegate.createSessionCookie(idToken, sessionCookieOptions);
  }

  verifySessionCookie(sessionCookie?: unknown, checkRevoked?: boolean): Promise<DecodedIdToken> {
    return this.delegate.verifySessionCookie(sessionCookie, checkRevoked);
  }

  generatePasswordResetLink(email?: unknown, actionCodeSettings?: unknown): Promise<string> {
    return this.delegate.generatePasswordResetLink(email, actionCodeSettings);
  }

  generateEmailVerificationLink(email?: unknown, actionCodeSettings?: unknown): Promise<string> {
    return this.delegate.generateEmailVerificationLink(email, actionCodeSettings);
  }

  generateSignInWithEmailLink(email?: unknown, actionCodeSettings?: unknown): Promise<string> {
    return this.delegate.generateSignInWithEmailLink(email, actionCodeSettings);
  }

  generateVerifyAndChangeEmailLink(
    email?: unknown,
    newEmail?: unknown,
    actionCodeSettings?: unknown,
  ): Promise<string> {
    return this.delegate.generateVerifyAndChangeEmailLink(email, newEmail, actionCodeSettings);
  }

  createProviderConfig(config?: unknown): Promise<unknown> {
    return this.delegate.createProviderConfig(config);
  }

  getProviderConfig(providerId?: unknown): Promise<unknown> {
    return this.delegate.getProviderConfig(providerId);
  }

  listProviderConfigs(options?: unknown): Promise<unknown> {
    return this.delegate.listProviderConfigs(options);
  }

  updateProviderConfig(providerId?: unknown, updatedConfig?: unknown): Promise<unknown> {
    return this.delegate.updateProviderConfig(providerId, updatedConfig);
  }

  deleteProviderConfig(providerId?: unknown): Promise<void> {
    return this.delegate.deleteProviderConfig(providerId);
  }
}
