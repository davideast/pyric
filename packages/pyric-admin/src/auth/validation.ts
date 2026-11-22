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
import { validateUpdateUserPreflight } from './preflight-validation.js';
import type { CreateRequest, ListUsersResult, UpdateRequest } from './types.js';
import { UserInfo } from './user-info.js';
import { UserMetadata } from './user-metadata.js';
import { UserRecord } from './user-record.js';
import { FirebaseAuthError } from './verify-token.js';

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
]);

const MAX_CLAIMS_PAYLOAD_SIZE = 1000;
const MAX_DOWNLOAD_ACCOUNT_PAGE_SIZE = 1000;
const BASIC_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface DecodedPageToken {
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

export function normalizeCustomUserClaims(customUserClaims: object | null): Record<string, unknown> {
  if (customUserClaims === null) return {};
  if (typeof customUserClaims !== 'object' || Array.isArray(customUserClaims)) {
    throw new FirebaseAuthError('argument-error', 'CustomUserClaims argument must be an object or null.');
  }
  const serialized = JSON.stringify(customUserClaims);
  const parsed = JSON.parse(serialized) as Record<string, unknown>;
  try {
    assertNoReservedCustomClaims(parsed);
  } catch (err) {
    const shaped = err as { code?: unknown; message?: unknown } | null;
    if (shaped !== null && typeof shaped === 'object' && shaped.code === 'auth/reserved-claim') {
      let msg = 'The specified developer claim is reserved and cannot be specified.';
      if (typeof shaped.message === 'string') {
        msg = shaped.message;
      }
      throw new FirebaseAuthError('reserved-claim', msg);
    }
    throw err;
  }
  if (serialized.length > MAX_CLAIMS_PAYLOAD_SIZE) {
    throw new FirebaseAuthError(
      'claims-too-large',
      `Developer claims payload should not exceed ${MAX_CLAIMS_PAYLOAD_SIZE} characters.`,
    );
  }
  return parsed;
}

export function assertValidCustomUserClaims(customUserClaims: object | null): void {
  normalizeCustomUserClaims(customUserClaims);
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
  if (code === 'auth/phone-number-already-exists') {
    return new FirebaseAuthError('phone-number-already-exists', message);
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
  if (code === 'auth/reserved-claim') {
    return new FirebaseAuthError('reserved-claim', message);
  }
  return err;
}

export function prepareSandboxUpdateRequest(
  uid: unknown,
  properties: UpdateRequest,
  notImplemented: (method: string) => Error,
): SandboxUpdateUserRequest {
  return validateUpdateUserPreflight(uid, properties, notImplemented);
}

function compareUids(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function encodePageToken(uid: string): string {
  return Buffer.from(JSON.stringify({ v: 1, uid }), 'utf8').toString('base64url');
}

function isCanonicalPageTokenPayload(
  parsed: unknown,
  pageToken: string,
): parsed is { readonly v: 1; readonly uid: string } {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false;
  }
  const candidate = parsed as { v?: unknown; uid?: unknown };
  if (candidate.v !== 1 || typeof candidate.uid !== 'string') {
    return false;
  }
  if (candidate.uid.length === 0 || candidate.uid.length > 128) {
    return false;
  }
  return encodePageToken(candidate.uid) === pageToken;
}

function decodePageToken(pageToken: string): DecodedPageToken {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(pageToken, 'base64url').toString('utf8'));
    if (isCanonicalPageTokenPayload(parsed, pageToken)) {
      return { uid: parsed.uid };
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
    Number.isNaN(maxResults) ||
    maxResults <= 0 ||
    maxResults > MAX_DOWNLOAD_ACCOUNT_PAGE_SIZE
  ) {
    throw new FirebaseAuthError(
      'argument-error',
      `Required "maxResults" must be a positive integer that does not exceed ${MAX_DOWNLOAD_ACCOUNT_PAGE_SIZE}.`,
    );
  }
  if (!Number.isInteger(maxResults)) {
    throw new FirebaseAuthError(
      'internal-error',
      'Invalid non-integer maxResults value provided.',
    );
  }
  let cursor: DecodedPageToken | null = null;
  if (pageToken !== undefined) {
    cursor = decodePageToken(pageToken);
  }
  return { max: maxResults, cursor };
}

export function paginateUserRecords(
  records: readonly AuthUserRecord[],
  maxResults = MAX_DOWNLOAD_ACCOUNT_PAGE_SIZE,
  pageToken?: string,
): ListUsersResult {
  const { max, cursor } = validateListUsersArguments(maxResults, pageToken);
  const sorted = [...records].sort((a, b) => compareUids(a.uid, b.uid));
  let remaining = sorted;
  if (cursor !== null) {
    remaining = sorted.filter((r) => compareUids(r.uid, cursor.uid) > 0);
  }
  const slice = remaining.slice(0, max);
  const users = slice.map(fromAuthUserRecord);
  const lastRecord = slice[slice.length - 1];
  if (lastRecord !== undefined && slice.length < remaining.length) {
    return {
      users,
      pageToken: encodePageToken(lastRecord.uid),
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
  let claims: Record<string, unknown> | undefined;
  if (developerClaims !== undefined) {
    claims = JSON.parse(JSON.stringify(developerClaims)) as Record<string, unknown>;
  }
  return Promise.resolve(mintCustomToken({ uid, claims, projectId: idTokenProjectId(app), nowMs }));
}

/**
 * Map a firebase-admin `CreateRequest` onto the sandbox create-user request.
 * `null`s become `undefined` because a fresh user has nothing to clear.
 */
export function toSandboxCreateRequest(props: CreateRequest): SandboxCreateUserRequest {
  const req: SandboxCreateUserRequest = {
    uid: props.uid,
    email: props.email,
    password: props.password,
    displayName: props.displayName ?? undefined,
    phoneNumber: props.phoneNumber ?? undefined,
    photoUrl: props.photoURL ?? undefined,
    disabled: props.disabled,
    emailVerified: props.emailVerified,
  };
  if (typeof props.phoneNumber === 'string' && props.phoneNumber.length > 0) {
    req.providerUserInfo = [{ providerId: 'phone' }];
  }
  return req;
}

function parseTimestampMs(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (/^-?\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
    return null;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return null;
}

function formatUtcTimestamp(raw: string | null | undefined): string | null {
  const ms = parseTimestampMs(raw);
  if (ms === null) {
    return null;
  }
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toUTCString();
}

function formatTokensValidAfterTime(r: AuthUserRecord): string | undefined {
  let validAfterMs: number | undefined;
  if (typeof r.tokensValidAfterMs === 'number' && Number.isFinite(r.tokensValidAfterMs)) {
    validAfterMs = Math.floor(r.tokensValidAfterMs / 1000) * 1000;
  } else {
    const parsedCreated = parseTimestampMs(r.createdAt);
    if (parsedCreated !== null) {
      validAfterMs = Math.floor(parsedCreated / 1000) * 1000;
    }
  }
  if (validAfterMs === undefined) return undefined;
  const date = new Date(validAfterMs);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toUTCString();
}

/**
 * Convert an `AuthUserRecord` from `pyric/auth` into a firebase-admin
 * `UserRecord` instance.
 */
export function fromAuthUserRecord(r: AuthUserRecord): UserRecord {
  const formattedCreationTime = formatUtcTimestamp(r.createdAt);
  let creationTime = r.createdAt;
  if (formattedCreationTime !== null) {
    creationTime = formattedCreationTime;
  }
  const lastSignInTime = formatUtcTimestamp(r.lastLoginAt);
  let rawLastRefreshAt: string | null;
  if (r.lastRefreshAt !== undefined) {
    rawLastRefreshAt = r.lastRefreshAt;
  } else {
    rawLastRefreshAt = r.lastLoginAt;
  }
  const lastRefreshTime = formatUtcTimestamp(rawLastRefreshAt);
  const metadata = new UserMetadata({
    creationTime,
    lastSignInTime,
    lastRefreshTime,
  });
  const providerData: UserInfo[] = r.providerUserInfo.map((p) => {
    let providerUid = r.uid;
    if (p.providerId === 'password' && r.email !== null) {
      providerUid = r.email;
    } else if (p.providerId === 'phone' && r.phoneNumber !== null) {
      providerUid = r.phoneNumber;
    }
    return new UserInfo({
      providerId: p.providerId,
      uid: providerUid,
      displayName: r.displayName ?? undefined,
      email: r.email ?? undefined,
      photoURL: r.photoUrl ?? undefined,
      phoneNumber: r.phoneNumber ?? undefined,
    });
  });
  let customClaims: Record<string, unknown> | undefined;
  if (Object.keys(r.customClaims).length > 0) {
    customClaims = r.customClaims as Record<string, unknown>;
  }
  const email = r.email ?? undefined;
  const tokensValidAfterTime = formatTokensValidAfterTime(r);
  let tenantId: string | null = null;
  if (typeof r.tenantId === 'string' && r.tenantId.length > 0) {
    tenantId = r.tenantId;
  }
  return new UserRecord({
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
    tokensValidAfterTime,
    tenantId,
  });
}
