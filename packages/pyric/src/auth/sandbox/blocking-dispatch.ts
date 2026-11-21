/**
 * Outbound Auth email and SMS blocking-hook dispatch (`beforeEmailSent` and
 * `beforeSmsSent`) plus the sandbox SMS verification outbox.
 */
import { makeAuthError } from '../auth-errors.js';
import type { StoredUser } from '../sandbox-backend-types.js';
import { SandboxBackend } from '../sandbox-backend.js';
import { targetOf } from '../target.js';
import type { Auth } from '../types.js';
import {
  getBackendAuthBlockingHooks,
  validateBeforeMessageResponse,
  type AuthBlockingClientContext,
  type AuthBlockingEmailType,
  type AuthBlockingSmsType,
  type AuthBlockingUserCandidate,
} from './blocking-hooks.js';
import { buildBlockingUserCandidate } from './blocking-sign-in.js';
import { normalizeTenantScope } from './tenant-isolation.js';

export interface OutboundAuthSms {
  phoneNumber: string;
  code: string;
  verificationId: string;
  smsType: AuthBlockingSmsType;
  tenantId: string | null;
  uid?: string;
  recaptchaActionOverride?: 'ALLOW' | 'BLOCK';
}

export interface SendAuthSmsRequest {
  phoneNumber: string;
  smsType?: AuthBlockingSmsType;
  uid?: string;
  tenantId?: string | null;
  client?: AuthBlockingClientContext;
}

const VALID_SMS_TYPES: ReadonlySet<string> = new Set<AuthBlockingSmsType>([
  'SIGN_IN_OR_SIGN_UP',
  'MULTI_FACTOR_SIGN_IN',
  'MULTI_FACTOR_ENROLLMENT',
]);

function assertE164PhoneNumber(phoneNumber: string): void {
  if (typeof phoneNumber !== 'string' || !/^\+[1-9]\d{4,14}$/.test(phoneNumber)) {
    throw makeAuthError(
      'auth/invalid-phone-number',
      'The phone number must be a valid E.164 string.',
    );
  }
}

function findStoredUserByPhone(
  backend: SandboxBackend,
  phoneNumber: string,
  tenantId: string | null,
): StoredUser | undefined {
  const store = SandboxBackend.projectStoreOf(backend);
  for (const candidate of store.usersByUid.values()) {
    if (
      normalizeTenantScope(candidate.tenantId) === tenantId &&
      candidate.phoneNumber === phoneNumber
    ) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Invoke `beforeSendEmail` if registered on the project store. Rejects before
 * any action code is minted or mail is written to the outbox.
 */
export async function runBeforeSendEmailForBackend(
  backend: SandboxBackend,
  input: {
    email: string;
    emailType: AuthBlockingEmailType;
    tenantId?: string | null;
    storedUser?: StoredUser;
    client?: AuthBlockingClientContext;
  },
): Promise<'ALLOW' | 'BLOCK' | undefined> {
  const beforeSendEmail = getBackendAuthBlockingHooks(backend)?.beforeSendEmail;
  if (beforeSendEmail === undefined) {
    return undefined;
  }
  let rawTenant = input.tenantId;
  if (rawTenant === undefined) {
    rawTenant = backend.getTenantId();
  }
  const effectiveTenant = normalizeTenantScope(rawTenant);
  let userRecord: AuthBlockingUserCandidate | undefined;
  if (input.storedUser !== undefined) {
    userRecord = buildBlockingUserCandidate(backend, input.storedUser);
  }
  const response = await beforeSendEmail({
    email: input.email,
    emailType: input.emailType,
    tenantId: effectiveTenant,
    userRecord,
    client: input.client,
  });
  return validateBeforeMessageResponse(response);
}

/**
 * Dispatch an outbound verification SMS through `beforeSendSms` (if active)
 * before minting a verification code or recording the message in `smsOutbox`.
 */
export async function sendBlockedAuthSms(
  auth: Auth,
  request: SendAuthSmsRequest,
): Promise<OutboundAuthSms> {
  const { backend } = targetOf(auth);
  assertE164PhoneNumber(request.phoneNumber);
  const smsType: AuthBlockingSmsType = request.smsType ?? 'SIGN_IN_OR_SIGN_UP';
  if (!VALID_SMS_TYPES.has(smsType)) {
    throw makeAuthError('auth/argument-error', `Unsupported SMS verification type: ${smsType}.`);
  }
  let rawTenant = request.tenantId;
  if (rawTenant === undefined) {
    rawTenant = backend.getTenantId();
  }
  const effectiveTenant = normalizeTenantScope(rawTenant);

  let storedUser: StoredUser | undefined;
  if (request.uid !== undefined) {
    const found = backend.findByUid(request.uid);
    if (found === undefined) {
      throw makeAuthError('auth/user-not-found', `No user found for uid ${request.uid}.`);
    }
    if (normalizeTenantScope(found.tenantId) !== effectiveTenant) {
      throw makeAuthError(
        'auth/tenant-id-mismatch',
        'The provided tenant ID does not match the user account tenant.',
      );
    }
    storedUser = found;
  } else {
    storedUser = findStoredUserByPhone(backend, request.phoneNumber, effectiveTenant);
  }

  const requiresExistingUser =
    smsType === 'MULTI_FACTOR_SIGN_IN' || smsType === 'MULTI_FACTOR_ENROLLMENT';
  if (requiresExistingUser && storedUser === undefined) {
    throw makeAuthError(
      'auth/user-not-found',
      'Multi-factor SMS verification requires an existing user account.',
    );
  }

  let recaptchaActionOverride: 'ALLOW' | 'BLOCK' | undefined;
  const beforeSendSms = getBackendAuthBlockingHooks(backend)?.beforeSendSms;
  if (beforeSendSms !== undefined) {
    let userRecord: AuthBlockingUserCandidate | undefined;
    if (storedUser !== undefined) {
      userRecord = buildBlockingUserCandidate(backend, storedUser);
    }
    const response = await beforeSendSms({
      phoneNumber: request.phoneNumber,
      smsType,
      tenantId: effectiveTenant,
      userRecord,
      client: request.client,
    });
    recaptchaActionOverride = validateBeforeMessageResponse(response);
  }

  const store = SandboxBackend.projectStoreOf(backend);
  const serial = store.counters.nextSmsCodeId++;
  const code = String(100000 + (serial % 900000)).padStart(6, '0');
  const message: OutboundAuthSms = {
    phoneNumber: request.phoneNumber,
    code,
    verificationId: `sandbox-sms-${serial}`,
    smsType,
    tenantId: effectiveTenant,
  };
  if (storedUser !== undefined) {
    message.uid = storedUser.uid;
  }
  if (recaptchaActionOverride !== undefined) {
    message.recaptchaActionOverride = recaptchaActionOverride;
  }
  store.smsOutbox.push(message);
  return structuredClone(message);
}

/** Read and remove the oldest outbound SMS message (optionally matching `phoneNumber`). */
export function takeAuthSms(auth: Auth, phoneNumber?: string): OutboundAuthSms | null {
  const store = SandboxBackend.projectStoreOf(targetOf(auth).backend);
  const outbox = store.smsOutbox as OutboundAuthSms[];
  let matchIndex = -1;
  if (phoneNumber === undefined) {
    if (outbox.length > 0) {
      matchIndex = 0;
    }
  } else {
    matchIndex = outbox.findIndex((item) => item.phoneNumber === phoneNumber);
  }
  if (matchIndex < 0) {
    return null;
  }
  const removed = outbox.splice(matchIndex, 1)[0];
  if (removed === undefined) {
    return null;
  }
  return structuredClone(removed);
}

/** Return a non-destructive snapshot of queued outbound SMS messages. */
export function listAuthSms(auth: Auth): OutboundAuthSms[] {
  const store = SandboxBackend.projectStoreOf(targetOf(auth).backend);
  const outbox = store.smsOutbox as OutboundAuthSms[];
  return outbox.map((item) => structuredClone(item));
}
