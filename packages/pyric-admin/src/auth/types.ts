/** Public interface types for `pyric-admin/auth`. */
import type { PyricAdminApp } from '../app/index.js';

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

export interface UserMetadata {
  creationTime: string;
  lastSignInTime: string;
  toJSON(): Record<string, unknown>;
}

export interface UserInfo {
  providerId: string;
  uid: string;
  displayName?: string;
  email?: string;
  photoURL?: string;
  phoneNumber?: string;
  toJSON(): Record<string, unknown>;
}

export interface UserRecord {
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
  readonly tenantId: string | null;
  toJSON(): Record<string, unknown>;
}

export interface ListUsersResult {
  users: UserRecord[];
  pageToken?: string;
}

/** Sandbox Auth interface intentionally limited to implemented behavior. */
export interface Auth {
  readonly app: PyricAdminApp;
  createCustomToken(uid: string, developerClaims?: object): Promise<string>;
  verifyIdToken(idToken: string, checkRevoked?: boolean): Promise<DecodedIdToken>;
  createUser(properties: CreateRequest): Promise<UserRecord>;
  getUser(uid: string): Promise<UserRecord>;
  getUserByEmail(email: string): Promise<UserRecord>;
  deleteUser(uid: string): Promise<void>;
  setCustomUserClaims(uid: string, customUserClaims: object | null): Promise<void>;
  updateUser(uid: string, properties: UpdateRequest): Promise<UserRecord>;
  listUsers(maxResults?: number, pageToken?: string): Promise<ListUsersResult>;
  [key: string]: unknown;
}
