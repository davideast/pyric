/**
 * Wire payload and `EventContext` builder for Gen 1 Firebase Auth lifecycle
 * triggers (`functions.auth.user().onCreate()` and `.onDelete()`).
 *
 * Matches `firebase-functions/lib/v1/providers/auth.js` (`UserBuilder`),
 * `lib/common/providers/identity.js` (`userRecordConstructor`), and
 * `lib/v1/cloud-functions.js` (`makeCloudFunction`).
 */
import type {
  AuthLifecycleEventType,
  DiscoveredAuthLifecycleTrigger,
} from './discovery.js';

export interface AuthLifecycleProviderInfoSnapshot {
  readonly providerId: string;
  readonly uid?: string;
  readonly displayName?: string | null;
  readonly email?: string | null;
  readonly photoURL?: string | null;
  readonly phoneNumber?: string | null;
}

export interface AuthLifecycleUserSnapshot {
  readonly uid: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly phoneNumber: string | null;
  readonly photoUrl: string | null;
  readonly customClaims: Record<string, unknown>;
  readonly providerUserInfo: readonly AuthLifecycleProviderInfoSnapshot[];
  readonly isAnonymous: boolean;
  readonly disabled: boolean;
  readonly emailVerified: boolean;
  readonly tenantId: string | null;
  readonly createdAt: string;
  readonly lastLoginAt: string | null;
  readonly lastRefreshAt?: string | null;
  readonly tokensValidAfterMs?: number;
}

export interface BuildAuthLifecycleContextOptions {
  eventId: string;
  eventType: AuthLifecycleEventType;
  projectId: string;
  timestamp: string;
}

export interface AuthLifecycleExecutionOptions {
  projectId: string;
}

export type AuthLifecycleExecutionResult =
  | { status: 'fulfilled' }
  | { status: 'rejected'; error: unknown };

function parseTimestampMs(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return null;
}

function formatUtcTimestamp(raw: string | null | undefined): string | null {
  const ms = parseTimestampMs(raw);
  if (ms === null) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return date.toUTCString();
}

function formatTokensValidAfterTime(user: AuthLifecycleUserSnapshot): string | null {
  let validAfterMs: number | undefined;
  if (typeof user.tokensValidAfterMs === 'number' && Number.isFinite(user.tokensValidAfterMs)) {
    validAfterMs = Math.floor(user.tokensValidAfterMs / 1000) * 1000;
  } else {
    const parsedCreated = parseTimestampMs(user.createdAt);
    if (parsedCreated !== null) {
      validAfterMs = Math.floor(parsedCreated / 1000) * 1000;
    }
  }
  if (validAfterMs === undefined) return null;
  const date = new Date(validAfterMs);
  if (Number.isNaN(date.getTime())) return null;
  return date.toUTCString();
}

function buildProviderData(
  user: AuthLifecycleUserSnapshot,
): Array<Record<string, unknown>> {
  return user.providerUserInfo.map((entry) => {
    let providerUid = user.uid;
    if (typeof entry.uid === 'string' && entry.uid.length > 0) {
      providerUid = entry.uid;
    } else if (entry.providerId === 'password' && user.email !== null) {
      providerUid = user.email;
    } else if (entry.providerId === 'phone' && user.phoneNumber !== null) {
      providerUid = user.phoneNumber;
    }
    return {
      uid: providerUid,
      providerId: entry.providerId,
      displayName: entry.displayName !== undefined ? entry.displayName : user.displayName,
      email: entry.email !== undefined ? entry.email : user.email,
      photoURL: entry.photoURL !== undefined ? entry.photoURL : user.photoUrl,
      phoneNumber: entry.phoneNumber !== undefined ? entry.phoneNumber : user.phoneNumber,
    };
  });
}

/**
 * Build the wire user payload passed to `firebase-functions/v1`'s
 * `userRecordConstructor(wireData)`. Absent scalar fields are explicitly `null`
 * (never `undefined`) so `{ ...falseyValues, ...wireData }` preserves Firebase's
 * null defaults.
 */
export function buildAuthLifecycleUserWireData(
  user: AuthLifecycleUserSnapshot,
): Record<string, unknown> {
  const creationTime = formatUtcTimestamp(user.createdAt) ?? user.createdAt;
  const lastSignInTime = formatUtcTimestamp(user.lastLoginAt);
  const wire: Record<string, unknown> = {
    uid: user.uid,
    email: user.email,
    emailVerified: Boolean(user.emailVerified),
    displayName: user.displayName,
    photoURL: user.photoUrl,
    phoneNumber: user.phoneNumber,
    disabled: Boolean(user.disabled),
    metadata: {
      creationTime,
      lastSignInTime,
    },
    providerData: buildProviderData(user),
    customClaims: structuredClone(user.customClaims),
    passwordHash: null,
    passwordSalt: null,
    tokensValidAfterTime: formatTokensValidAfterTime(user),
  };
  if (typeof user.tenantId === 'string' && user.tenantId.length > 0) {
    wire.tenantId = user.tenantId;
  }
  return wire;
}

/**
 * Build the legacy-shaped Gen 1 `EventContext` consumed by `makeCloudFunction`.
 * `makeCloudFunction` converts `legacyEventType` -> `google.firebase.auth.user.*`
 * and string `resource` -> `{ service: 'firebaseauth.googleapis.com', name }`.
 */
export function buildAuthLifecycleEventContext(
  options: BuildAuthLifecycleContextOptions,
): Record<string, unknown> {
  return {
    eventId: options.eventId,
    timestamp: options.timestamp,
    eventType: options.eventType,
    resource: `projects/${options.projectId}`,
    params: {},
  };
}

/**
 * Invoke a discovered Gen 1 Auth trigger cleanly, cloning payload and context
 * per invocation so `makeCloudFunction`'s in-place context mutation never leaks
 * across sibling triggers.
 */
export async function executeAuthLifecycleTrigger(
  trigger: DiscoveredAuthLifecycleTrigger,
  wireData: Record<string, unknown>,
  context: Record<string, unknown>,
  options: AuthLifecycleExecutionOptions,
): Promise<AuthLifecycleExecutionResult> {
  const hadProjectEnv =
    typeof process.env.GCLOUD_PROJECT === 'string' && process.env.GCLOUD_PROJECT.length > 0;
  const priorProjectEnv = process.env.GCLOUD_PROJECT;
  if (!hadProjectEnv && options.projectId.length > 0) {
    process.env.GCLOUD_PROJECT = options.projectId;
  }
  try {
    await trigger.callable(structuredClone(wireData), structuredClone(context));
    return { status: 'fulfilled' };
  } catch (error: unknown) {
    return { status: 'rejected', error };
  } finally {
    if (!hadProjectEnv) {
      if (priorProjectEnv === undefined) {
        delete process.env.GCLOUD_PROJECT;
      } else {
        process.env.GCLOUD_PROJECT = priorProjectEnv;
      }
    }
  }
}
