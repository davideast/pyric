/**
 * Input validation, error translation, and record conversion for `pyric-admin/auth`.
 */
import {
  assertNoReservedCustomClaims,
  mintCustomToken,
  SANDBOX_PROJECT_ID,
} from 'pyric/sandbox/internal';
import type {
  AuthUserRecord,
  CreateUserRequest as SandboxCreateUserRequest,
  UpdateUserRequest as SandboxUpdateUserRequest,
} from 'pyric/auth';
import type { PyricAdminApp } from '../app/index.js';
import { explicitProjectId } from '../app/project-id.js';
import type { CreateRequest, ListUsersResult, UpdateRequest, UserInfo, UserRecord } from './types.js';
import { FirebaseAuthError, invalidUid } from './verify-token.js';

const RESERVED_CUSTOM_TOKEN_CLAIMS = new Set([
  'acr',
  'amr',
  'at_hash',
  'aud',
  'auth_time',
  'azp',
  'cnf',
  'c_hash',
  'exp',
  'iat',
  'iss',
  'jti',
  'nbf',
  'nonce',
  'sub',
]);

const MAX_CLAIMS_PAYLOAD_SIZE = 1000;
const MAX_DOWNLOAD_ACCOUNT_PAGE_SIZE = 1000;
const BASIC_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UNSUPPORTED_UPDATE_KEYS = [
  'photoURL',
  'phoneNumber',
  'multiFactor',
  'providerToLink',
  'providersToUnlink',
] as const;

interface DecodedPageToken {
  readonly offset: number;
  readonly uid: string;
}

export function assertCustomTokenArguments(uid: unknown, developerClaims?: unknown): void {
  if (typeof uid !== 'string' || uid.length === 0) {
    throw new FirebaseAuthError('argument-error', '`uid` argument must be a non-empty string uid.');
  }
  if (uid.length > 128) {
    throw new FirebaseAuthError(
      'argument-error',
      '`uid` argument must a uid with less than or equal to 128 characters.',
    );
  }
  if (developerClaims !== undefined) {
    if (typeof developerClaims !== 'object' || developerClaims === null || Array.isArray(developerClaims)) {
      throw new FirebaseAuthError(
        'argument-error',
        '`developerClaims` argument must be a valid, non-null object containing the developer claims.',
      );
    }
    for (const key of Object.keys(developerClaims as Record<string, unknown>)) {
      if (RESERVED_CUSTOM_TOKEN_CLAIMS.has(key)) {
        throw new FirebaseAuthError(
          'argument-error',
          `Developer claim "${key}" is reserved and cannot be specified.`,
        );
      }
    }
  }
}

export function assertValidCustomUserClaims(customUserClaims: object | null): void {
  if (customUserClaims === null) return;
  if (typeof customUserClaims !== 'object' || Array.isArray(customUserClaims)) {
    throw new FirebaseAuthError('argument-error', 'CustomUserClaims argument must be an object or null.');
  }
  assertNoReservedCustomClaims(customUserClaims as Record<string, unknown>);
  if (JSON.stringify(customUserClaims).length > MAX_CLAIMS_PAYLOAD_SIZE) {
    throw new FirebaseAuthError(
      'claims-too-large',
      `Developer claims payload should not exceed ${MAX_CLAIMS_PAYLOAD_SIZE} characters.`,
    );
  }
}

export function validateAdminEmail(email: unknown): FirebaseAuthError | null {
  if (typeof email !== 'string' || email.trim() !== email || !BASIC_EMAIL_PATTERN.test(email)) {
    return new FirebaseAuthError('invalid-email', 'The email address is improperly formatted.');
  }
  return null;
}

export function validateAdminPassword(password: unknown): FirebaseAuthError | null {
  if (typeof password !== 'string' || password.length < 6) {
    return new FirebaseAuthError('invalid-password', 'The password must be a string with at least 6 characters.');
  }
  return null;
}

export function translateAdminBackendError(err: unknown): unknown {
  const code = (err as { code?: unknown } | null)?.code;
  const message = (err as { message?: string } | null)?.message ?? 'Auth error';
  if (code === 'auth/uid-already-exists') {
    return new FirebaseAuthError('uid-already-exists', message);
  }
  if (code === 'auth/email-already-in-use') {
    return new FirebaseAuthError('email-already-exists', message);
  }
  if (code === 'auth/weak-password') {
    return new FirebaseAuthError('invalid-password', message);
  }
  if (code === 'auth/invalid-email') {
    return new FirebaseAuthError('invalid-email', message);
  }
  if (code === 'auth/user-not-found') {
    return new FirebaseAuthError('user-not-found', message);
  }
  return err;
}

export function prepareSandboxUpdateRequest(
  uid: unknown,
  properties: UpdateRequest,
  notImplemented: (method: string) => Error,
): SandboxUpdateUserRequest {
  const uidErr = invalidUid(uid);
  if (uidErr !== null) throw uidErr;
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    throw new FirebaseAuthError('argument-error', 'Properties argument must be a non-null object.');
  }
  const propRecord = properties as Record<string, unknown>;
  const unsupported = UNSUPPORTED_UPDATE_KEYS.filter(
    (key) => Object.hasOwn(propRecord, key) && propRecord[key] !== undefined,
  );
  if (unsupported.length > 0) {
    throw notImplemented(`updateUser({ ${unsupported.join(', ')} })`);
  }
  if (properties.email !== undefined) {
    const emailErr = validateAdminEmail(properties.email);
    if (emailErr !== null) throw emailErr;
  }
  if (properties.password !== undefined) {
    const pwErr = validateAdminPassword(properties.password);
    if (pwErr !== null) throw pwErr;
  }
  return {
    displayName: properties.displayName,
    email: properties.email,
    password: properties.password,
    disabled: properties.disabled,
    emailVerified: properties.emailVerified,
  };
}

function encodePageToken(offset: number, uid: string): string {
  return Buffer.from(JSON.stringify({ v: 1, offset, uid }), 'utf8').toString('base64url');
}

function decodePageToken(pageToken: string): DecodedPageToken {
  try {
    const parsed = JSON.parse(Buffer.from(pageToken, 'base64url').toString('utf8')) as {
      v?: unknown;
      offset?: unknown;
      uid?: unknown;
    };
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      parsed.v === 1 &&
      typeof parsed.offset === 'number' &&
      Number.isInteger(parsed.offset) &&
      parsed.offset >= 0 &&
      typeof parsed.uid === 'string' &&
      parsed.uid.length > 0
    ) {
      return { offset: parsed.offset, uid: parsed.uid };
    }
  } catch {
    // Fall through to FirebaseAuthError below.
  }
  throw new FirebaseAuthError('invalid-page-token', 'The provided next page token is invalid.');
}

export function validateListUsersArguments(
  maxResults = MAX_DOWNLOAD_ACCOUNT_PAGE_SIZE,
  pageToken?: string,
): { max: number; cursor: DecodedPageToken | null } {
  if (pageToken !== undefined && (typeof pageToken !== 'string' || pageToken.length === 0)) {
    throw new FirebaseAuthError('invalid-page-token', 'The page token must be a valid non-empty string.');
  }
  if (
    typeof maxResults !== 'number' ||
    !Number.isInteger(maxResults) ||
    maxResults <= 0 ||
    maxResults > MAX_DOWNLOAD_ACCOUNT_PAGE_SIZE
  ) {
    throw new FirebaseAuthError(
      'argument-error',
      `Required "maxResults" must be a positive integer that does not exceed ${MAX_DOWNLOAD_ACCOUNT_PAGE_SIZE}.`,
    );
  }
  return {
    max: maxResults,
    cursor: pageToken !== undefined ? decodePageToken(pageToken) : null,
  };
}

export function paginateUserRecords(
  records: readonly AuthUserRecord[],
  maxResults = MAX_DOWNLOAD_ACCOUNT_PAGE_SIZE,
  pageToken?: string,
): ListUsersResult {
  const { max, cursor } = validateListUsersArguments(maxResults, pageToken);
  let startIndex = 0;
  if (cursor !== null) {
    const idx = records.findIndex((r) => r.uid === cursor.uid);
    startIndex = idx >= 0 ? idx + 1 : cursor.offset;
  }
  const slice = records.slice(startIndex, startIndex + max);
  const users = slice.map(fromAuthUserRecord);
  if (slice.length > 0 && startIndex + slice.length < records.length) {
    return {
      users,
      pageToken: encodePageToken(startIndex + slice.length, slice[slice.length - 1]!.uid),
    };
  }
  return { users };
}

/**
 * The project an ID token must name for `app`: firebase-admin's explicit
 * project ID, or `pyric-sandbox` when `app` names none.
 */
export function idTokenProjectId(app: PyricAdminApp): string {
  return explicitProjectId(app) ?? SANDBOX_PROJECT_ID;
}

/**
 * Mint a sandbox custom token for the app's project at `nowMs`, in
 * firebase-admin's shape (`pyric/sandbox/internal` `mintCustomToken`).
 */
export function mintSandboxCustomToken(
  app: PyricAdminApp,
  nowMs: number,
  uid: string,
  developerClaims?: object,
): Promise<string> {
  const claims = developerClaims as Record<string, unknown> | undefined;
  return Promise.resolve(mintCustomToken({ uid, claims, projectId: idTokenProjectId(app), nowMs }));
}

/**
 * Map a firebase-admin `CreateRequest` onto the sandbox create-user request.
 * `null`s become `undefined` because a fresh user has nothing to clear.
 */
export function toSandboxCreateRequest(props: CreateRequest): SandboxCreateUserRequest {
  return {
    uid: props.uid,
    email: props.email,
    password: props.password,
    displayName: props.displayName ?? undefined,
    phoneNumber: props.phoneNumber ?? undefined,
    photoUrl: props.photoURL ?? undefined,
    disabled: props.disabled,
    emailVerified: props.emailVerified,
  };
}

/**
 * Convert an `AuthUserRecord` from `pyric/auth` into a firebase-admin
 * `UserRecord`-shaped object.
 */
export function fromAuthUserRecord(r: AuthUserRecord): UserRecord {
  const lastSignInTime = r.lastLoginAt ?? '';
  const metadata: UserRecord['metadata'] = {
    creationTime: r.createdAt,
    lastSignInTime,
    toJSON: () => ({ creationTime: r.createdAt, lastSignInTime }),
  };
  const providerData: UserInfo[] = r.providerUserInfo.map((p) => ({
    providerId: p.providerId,
    uid: r.uid,
    displayName: r.displayName ?? undefined,
    email: r.email ?? undefined,
    photoURL: r.photoUrl ?? undefined,
    phoneNumber: r.phoneNumber ?? undefined,
    toJSON: () => ({ providerId: p.providerId, uid: r.uid }),
  }));
  let customClaims: Record<string, unknown> | undefined;
  if (Object.keys(r.customClaims).length > 0) {
    customClaims = r.customClaims as Record<string, unknown>;
  }
  const email = r.email ?? undefined;
  return {
    uid: r.uid,
    email,
    emailVerified: r.emailVerified,
    displayName: r.displayName ?? undefined,
    photoURL: r.photoUrl ?? undefined,
    phoneNumber: r.phoneNumber ?? undefined,
    disabled: r.disabled,
    metadata,
    providerData,
    customClaims,
    tenantId: null,
    toJSON: () => ({ uid: r.uid, email }),
  };
}
