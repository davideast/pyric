/**
 * Strict PII-free observation writer and validator for `auth-google-oauth` (#1814).
 *
 * Stores ONLY booleans, canonical provider IDs, and `auth/*` error codes inside
 * `behavior` (with zero emails, UIDs, display names, photo URLs, project IDs,
 * or tokens anywhere in the written JSON). Fails closed before writing if any
 * forbidden key, unrecognized string format, or known sensitive runtime value
 * reaches the payload.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const AUTH_GOOGLE_OAUTH_OBSERVATION_NAME = 'auth-google-oauth-unverified-collision';

export interface SanitizedGoogleCollisionCaseBehavior {
  readonly seededBaselinePasswordSignInSucceeded: boolean;
  readonly seededBaselineEmailVerified: boolean;
  readonly seededBaselineProviderIds: readonly string[];
  readonly popupSucceeded: boolean;
  readonly popupErrorCode: string | null;
  readonly credentialFromResultPresent: boolean;
  readonly credentialFromErrorPresent: boolean;
  readonly resolvedSameUidAsSeeded: boolean | null;
  readonly resolvedUserEmailVerified: boolean | null;
  readonly resolvedUserProviderIds: readonly string[] | null;
  readonly resolvedTokenEmailVerifiedClaim: boolean | null;
  readonly resolvedTokenSignInProvider: string | null;
  readonly seededRecordStillExists: boolean;
  readonly postAttemptAdminEmailVerified: boolean | null;
  readonly postAttemptAdminHasPasswordHash: boolean | null;
  readonly postAttemptAdminProviderIds: readonly string[] | null;
  readonly postAttemptPasswordSignInSucceeded: boolean;
  readonly postAttemptPasswordErrorCode: string | null;
}

export interface AuthGoogleOAuthBehavior {
  readonly projectAllowDuplicateEmails: boolean | null;
  readonly gmailUnverifiedAccountCollision: SanitizedGoogleCollisionCaseBehavior;
  readonly nonGmailUnverifiedAccountCollision: SanitizedGoogleCollisionCaseBehavior;
}

export interface AuthGoogleOAuthObservation {
  readonly name: typeof AUTH_GOOGLE_OAUTH_OBSERVATION_NAME;
  readonly matrixRow: string;
  readonly rowIds: readonly string[];
  readonly description: string;
  readonly observedAt: string;
  readonly fbSdkVersion: string;
  readonly adminSdkVersion: string;
  readonly behavior: AuthGoogleOAuthBehavior;
}

const ALLOWED_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'name',
  'matrixRow',
  'rowIds',
  'description',
  'observedAt',
  'fbSdkVersion',
  'adminSdkVersion',
  'behavior',
]);

const FORBIDDEN_BEHAVIOR_KEYS: ReadonlySet<string> = new Set([
  'email',
  'gmailEmail',
  'nonGmailEmail',
  'observedEmail',
  'uid',
  'localId',
  'seededUid',
  'resolvedUid',
  'displayName',
  'name',
  'screenName',
  'photoURL',
  'photoUrl',
  'picture',
  'phoneNumber',
  'idToken',
  'accessToken',
  'refreshToken',
  'oauthIdToken',
  'oauthAccessToken',
  'pendingToken',
  'token',
  'password',
  'passwordHash',
  'salt',
  'rawId',
  'federatedId',
  'projectId',
  'apiKey',
  'appId',
  'message',
  'errorMessage',
]);

const CANONICAL_PROVIDER_IDS: ReadonlySet<string> = new Set([
  'password',
  'phone',
  'anonymous',
  'custom',
  'emailLink',
  'google.com',
  'facebook.com',
  'github.com',
  'twitter.com',
  'microsoft.com',
  'apple.com',
  'yahoo.com',
  'playgames.google.com',
  'gc.apple.com',
]);

const CUSTOM_PROVIDER_PREFIX_PATTERN = /^(?:oidc|saml)\.[a-z0-9-]+$/;
const AUTH_ERROR_CODE_PATTERN = /^auth\/[a-z0-9-]+$/;
const URL_SCHEME_PATTERN = /^(?:https?:|gs:|data:|blob:|file:)/i;
const JWT_LIKE_PATTERN = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/;

function isAllowedProviderId(value: string): boolean {
  return CANONICAL_PROVIDER_IDS.has(value) || CUSTOM_PROVIDER_PREFIX_PATTERN.test(value);
}

function isAllowedAuthErrorCode(value: string): boolean {
  return AUTH_ERROR_CODE_PATTERN.test(value);
}

export function sanitizeAuthErrorCode(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const rawCode = (err as { code?: unknown }).code;
    if (typeof rawCode === 'string' && isAllowedAuthErrorCode(rawCode)) {
      return rawCode;
    }
  }
  return 'auth/unknown';
}

export function sanitizeProviderIdList(rawIds: readonly unknown[]): string[] {
  const cleaned: string[] = [];
  for (const item of rawIds) {
    if (typeof item !== 'string' || !isAllowedProviderId(item)) {
      throw new Error(
        `Observation sanitizer refused unrecognized providerId value: ${JSON.stringify(item)}`,
      );
    }
    if (!cleaned.includes(item)) {
      cleaned.push(item);
    }
  }
  return cleaned.sort();
}

function assertCleanBehaviorValue(
  value: unknown,
  path: string,
  forbiddenNeedles: readonly string[],
): void {
  if (value === null || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    for (const needle of forbiddenNeedles) {
      if (needle.length > 0 && lower.includes(needle)) {
        throw new Error(`Observation sanitizer blocked sensitive runtime value at '${path}'.`);
      }
    }
    if (value.includes('@')) {
      throw new Error(`Observation sanitizer blocked email-shaped string at '${path}'.`);
    }
    if (URL_SCHEME_PATTERN.test(value)) {
      throw new Error(`Observation sanitizer blocked URL string at '${path}'.`);
    }
    if (JWT_LIKE_PATTERN.test(value) || value.length > 64) {
      throw new Error(`Observation sanitizer blocked token/UID-shaped string at '${path}'.`);
    }
    if (!isAllowedAuthErrorCode(value) && !isAllowedProviderId(value)) {
      throw new Error(
        `Observation sanitizer blocked non-allowlisted string '${value}' at '${path}' (only booleans, provider ids, and auth/* error codes are permitted).`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertCleanBehaviorValue(value[i], `${path}[${i}]`, forbiddenNeedles);
    }
    return;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (FORBIDDEN_BEHAVIOR_KEYS.has(key)) {
        throw new Error(`Observation sanitizer blocked forbidden key '${key}' at '${path}.${key}'.`);
      }
      assertCleanBehaviorValue(record[key], `${path}.${key}`, forbiddenNeedles);
    }
    return;
  }
  throw new Error(
    `Observation sanitizer blocked unsupported primitive type '${typeof value}' at '${path}' (only booleans, provider ids, auth/* error codes, arrays, objects, and null are permitted).`,
  );
}

/**
 * Validates that `observation` contains zero emails, UIDs, display names, photo
 * URLs, project identifiers, or tokens anywhere in the envelope or `behavior`.
 */
export function assertNoSensitiveFieldsInObservation(
  observation: unknown,
  sensitiveRuntimeValues: readonly string[] = [],
): void {
  if (typeof observation !== 'object' || observation === null || Array.isArray(observation)) {
    throw new Error('Observation payload must be a plain JSON object.');
  }
  const root = observation as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      throw new Error(`Observation sanitizer blocked unexpected top-level key '${key}'.`);
    }
  }

  const normalizedNeedles = sensitiveRuntimeValues
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length >= 3);

  for (const topKey of ['name', 'matrixRow', 'description', 'observedAt', 'fbSdkVersion', 'adminSdkVersion']) {
    const val = root[topKey];
    if (typeof val !== 'string') {
      throw new Error(`Observation missing required string field '${topKey}'.`);
    }
    const lowerVal = val.toLowerCase();
    for (const needle of normalizedNeedles) {
      if (lowerVal.includes(needle)) {
        throw new Error(`Observation sanitizer blocked sensitive value in top-level '${topKey}'.`);
      }
    }
    if (topKey !== 'description' && val.includes('@')) {
      throw new Error(`Observation sanitizer blocked '@' in top-level '${topKey}'.`);
    }
    if (URL_SCHEME_PATTERN.test(val)) {
      throw new Error(`Observation sanitizer blocked URL in top-level '${topKey}'.`);
    }
  }

  if (!Array.isArray(root.rowIds)) {
    throw new Error("Observation 'rowIds' must be an array.");
  }
  for (let i = 0; i < root.rowIds.length; i += 1) {
    const rowId = root.rowIds[i];
    if (typeof rowId !== 'string') {
      throw new Error(`Observation 'rowIds[${i}]' must be a string.`);
    }
  }

  if (typeof root.behavior !== 'object' || root.behavior === null || Array.isArray(root.behavior)) {
    throw new Error("Observation 'behavior' must be a plain object.");
  }
  assertCleanBehaviorValue(root.behavior, 'behavior', normalizedNeedles);
}

export interface WriteAuthGoogleOAuthObservationOptions {
  readonly obsDir: string;
  readonly fbSdkVersion: string;
  readonly adminSdkVersion: string;
  readonly behavior: AuthGoogleOAuthBehavior;
  readonly rowIds?: readonly string[];
  readonly observedAt?: string;
  readonly sensitiveRuntimeValues?: readonly string[];
}

function buildAuthGoogleOAuthObservation(
  options: Omit<WriteAuthGoogleOAuthObservationOptions, 'obsDir'>,
): AuthGoogleOAuthObservation {
  let rowIds: readonly string[] = [];
  if (options.rowIds !== undefined) {
    rowIds = [...options.rowIds];
  }
  let observedAt = new Date().toISOString();
  if (options.observedAt !== undefined) {
    observedAt = options.observedAt;
  }
  const doc: AuthGoogleOAuthObservation = {
    name: AUTH_GOOGLE_OAUTH_OBSERVATION_NAME,
    matrixRow: '',
    rowIds,
    description:
      'Production google.com OAuth popup sign-in collision against run-scoped unverified password accounts (@gmail.com and non-@gmail.com), recording sanitized booleans, provider IDs, and error codes (#1814).',
    observedAt,
    fbSdkVersion: options.fbSdkVersion,
    adminSdkVersion: options.adminSdkVersion,
    behavior: options.behavior,
  };
  assertNoSensitiveFieldsInObservation(doc, options.sensitiveRuntimeValues ?? []);
  return doc;
}

export function writeAuthGoogleOAuthObservation(
  options: WriteAuthGoogleOAuthObservationOptions,
): { filePath: string; observation: AuthGoogleOAuthObservation } {
  const observation = buildAuthGoogleOAuthObservation(options);
  const serialized = `${JSON.stringify(observation, null, 2)}\n`;
  const reparsed: unknown = JSON.parse(serialized);
  assertNoSensitiveFieldsInObservation(reparsed, options.sensitiveRuntimeValues ?? []);
  mkdirSync(options.obsDir, { recursive: true });
  const filePath = join(options.obsDir, `${AUTH_GOOGLE_OAUTH_OBSERVATION_NAME}.json`);
  writeFileSync(filePath, serialized, 'utf8');
  return { filePath, observation };
}
