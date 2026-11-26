/** Public and internal interfaces for `pyric-admin/auth`. */
import type { UserInfo } from './user-info.js';
import type { UserMetadata } from './user-metadata.js';
import type { UserRecord } from './user-record.js';

export interface CreateRequest {
  uid?: string;
  email?: string;
  emailVerified?: boolean;
  displayName?: string | null;
  photoURL?: string | null;
  phoneNumber?: string | null;
  disabled?: boolean;
  password?: string;
}

export interface UpdateRequest extends Omit<CreateRequest, 'uid'> {
  multiFactor?: unknown;
  providerToLink?: unknown;
  providersToUnlink?: unknown;
}

export interface DecodedIdToken extends Record<string, unknown> {
  aud: string;
  auth_time: number;
  exp: number;
  firebase: { identities: Record<string, unknown>; sign_in_provider: string };
  iat: number;
  iss: string;
  sub: string;
  uid: string;
}

export interface UserMetadataInit {
  readonly creationTime: string;
  readonly lastSignInTime: string | null;
  readonly lastRefreshTime?: string | null;
}

export interface UserInfoInit {
  readonly providerId: string;
  readonly uid: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly photoURL?: string;
  readonly phoneNumber?: string;
}

export interface UserRecordInit {
  readonly uid: string;
  readonly email?: string;
  readonly emailVerified: boolean;
  readonly displayName?: string;
  readonly photoURL?: string;
  readonly phoneNumber?: string;
  readonly disabled: boolean;
  readonly metadata: UserMetadata;
  readonly providerData: UserInfo[];
  readonly customClaims?: Record<string, unknown>;
  readonly tokensValidAfterTime?: string;
  readonly tenantId: string | null;
}

export interface SessionCookieOptions {
  expiresIn: number;
}

export interface ListUsersResult {
  users: UserRecord[];
  pageToken?: string;
}

export interface BaseAuthDelegate {
  createCustomToken(uid: string, developerClaims?: object): Promise<string>;
  verifyIdToken(idToken: string, checkRevoked?: boolean): Promise<DecodedIdToken>;
  createUser(properties: CreateRequest): Promise<UserRecord>;
  getUser(uid: string): Promise<UserRecord>;
  getUserByEmail(email: string): Promise<UserRecord>;
  deleteUser(uid: string): Promise<void>;
  setCustomUserClaims(uid: string, customUserClaims: object | null): Promise<void>;
  revokeRefreshTokens(uid: string): Promise<void>;
  updateUser(uid: string, properties: UpdateRequest): Promise<UserRecord>;
  listUsers(maxResults?: number, pageToken?: string): Promise<ListUsersResult>;
  getUserByPhoneNumber(phoneNumber?: unknown): Promise<UserRecord>;
  getUserByProviderUid(providerId?: unknown, uid?: unknown): Promise<UserRecord>;
  getUsers(identifiers?: unknown): Promise<unknown>;
  deleteUsers(uids?: unknown): Promise<unknown>;
  importUsers(users?: unknown, options?: unknown): Promise<unknown>;
  createSessionCookie(idToken: string, sessionCookieOptions: SessionCookieOptions): Promise<string>;
  verifySessionCookie(sessionCookie: string, checkRevoked?: boolean): Promise<DecodedIdToken>;
  generatePasswordResetLink(email?: unknown, actionCodeSettings?: unknown): Promise<string>;
  generateEmailVerificationLink(email?: unknown, actionCodeSettings?: unknown): Promise<string>;
  generateSignInWithEmailLink(email?: unknown, actionCodeSettings?: unknown): Promise<string>;
  generateVerifyAndChangeEmailLink(
    email?: unknown,
    newEmail?: unknown,
    actionCodeSettings?: unknown,
  ): Promise<string>;
  createProviderConfig(config?: unknown): Promise<unknown>;
  getProviderConfig(providerId?: unknown): Promise<unknown>;
  listProviderConfigs(options?: unknown): Promise<unknown>;
  updateProviderConfig(providerId?: unknown, updatedConfig?: unknown): Promise<unknown>;
  deleteProviderConfig(providerId?: unknown): Promise<void>;
}
