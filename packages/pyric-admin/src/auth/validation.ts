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
} from 'pyric/auth';
import type { PyricAdminApp } from '../app/index.js';
import { explicitProjectId } from '../app/project-id.js';
import type { CreateRequest, UserInfo, UserRecord } from './types.js';
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
  'sub',
]);

const MAX_CLAIMS_PAYLOAD_SIZE = 1000;
const BASIC_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  return err;
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
