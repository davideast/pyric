/** Public types and runtime classes for `pyric-admin/auth`. */
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

export interface UserMetadataInit {
  readonly creationTime: string;
  readonly lastSignInTime: string;
  readonly lastRefreshTime?: string | null;
}

export class UserMetadata {
  readonly creationTime: string;
  readonly lastSignInTime: string;
  readonly lastRefreshTime?: string | null;

  constructor(init: UserMetadataInit) {
    this.creationTime = init.creationTime;
    this.lastSignInTime = init.lastSignInTime;
    if (init.lastRefreshTime !== undefined) {
      this.lastRefreshTime = init.lastRefreshTime;
    }
  }

  toJSON(): Record<string, unknown> {
    const json: Record<string, unknown> = {
      creationTime: this.creationTime,
      lastSignInTime: this.lastSignInTime,
    };
    if (this.lastRefreshTime !== undefined) {
      json.lastRefreshTime = this.lastRefreshTime;
    }
    return json;
  }
}

export interface UserInfoInit {
  readonly providerId: string;
  readonly uid: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly photoURL?: string;
  readonly phoneNumber?: string;
}

export class UserInfo {
  readonly providerId: string;
  readonly uid: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly photoURL?: string;
  readonly phoneNumber?: string;

  constructor(init: UserInfoInit) {
    this.providerId = init.providerId;
    this.uid = init.uid;
    this.displayName = init.displayName;
    this.email = init.email;
    this.photoURL = init.photoURL;
    this.phoneNumber = init.phoneNumber;
  }

  toJSON(): Record<string, unknown> {
    return {
      uid: this.uid,
      displayName: this.displayName,
      email: this.email,
      photoURL: this.photoURL,
      providerId: this.providerId,
      phoneNumber: this.phoneNumber,
    };
  }
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

export class UserRecord {
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

  constructor(init: UserRecordInit) {
    this.uid = init.uid;
    this.email = init.email;
    this.emailVerified = init.emailVerified;
    this.displayName = init.displayName;
    this.photoURL = init.photoURL;
    this.phoneNumber = init.phoneNumber;
    this.disabled = init.disabled;
    this.metadata = init.metadata;
    this.providerData = init.providerData;
    this.customClaims = init.customClaims;
    this.tokensValidAfterTime = init.tokensValidAfterTime;
    this.tenantId = init.tenantId;
  }

  toJSON(): Record<string, unknown> {
    let clonedClaims: Record<string, unknown> | undefined;
    if (this.customClaims !== undefined) {
      clonedClaims = JSON.parse(JSON.stringify(this.customClaims)) as Record<string, unknown>;
    }
    return {
      uid: this.uid,
      email: this.email,
      emailVerified: this.emailVerified,
      displayName: this.displayName,
      photoURL: this.photoURL,
      phoneNumber: this.phoneNumber,
      disabled: this.disabled,
      metadata: this.metadata.toJSON(),
      customClaims: clonedClaims,
      tokensValidAfterTime: this.tokensValidAfterTime,
      tenantId: this.tenantId,
      providerData: this.providerData.map((entry) => entry.toJSON()),
    };
  }
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
  createSessionCookie(idToken?: unknown, sessionCookieOptions?: unknown): Promise<string>;
  verifySessionCookie(sessionCookie?: unknown, checkRevoked?: boolean): Promise<DecodedIdToken>;
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

/** Common parent runtime class for `pyric-admin/auth` handles (`firebase-admin/auth` `BaseAuth`). */
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

/** App-bound `Auth` service class (`firebase-admin/auth` `Auth extends BaseAuth`). */
export class Auth extends BaseAuth {
  private readonly boundApp: PyricAdminApp;
  private readonly throwUnmodeledManager: (method: string) => never;

  constructor(
    app: PyricAdminApp,
    delegate: BaseAuthDelegate,
    throwUnmodeledManager: (method: string) => never,
  ) {
    super(delegate);
    this.boundApp = app;
    this.throwUnmodeledManager = throwUnmodeledManager;
  }

  get app(): PyricAdminApp {
    return this.boundApp;
  }

  get tenantManager(): never {
    return this.throwUnmodeledManager('tenantManager');
  }

  get projectConfigManager(): never {
    return this.throwUnmodeledManager('projectConfigManager');
  }
}
