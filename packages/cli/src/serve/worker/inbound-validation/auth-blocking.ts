import {
  requireOptionalBoolean,
  requireOptionalString,
  requireRecord,
  requireShape,
  requireString,
} from './fields.js';

/** Validate `sub` messages targeting `authBlocking` from the Functions child. */
export function assertAuthBlockingSubArguments(message: Record<string, unknown>): void {
  const triggers = message.triggers;
  requireShape(Array.isArray(triggers), 'triggers');
  for (const entry of triggers as unknown[]) {
    requireRecord(entry, 'triggers[]');
    requireString(entry.exportName, 'triggers[].exportName');
    requireString(entry.eventType, 'triggers[].eventType');
    requireRecord(entry.options, 'triggers[].options');
    requireOptionalBoolean(entry.options.idToken, 'triggers[].options.idToken');
    requireOptionalBoolean(entry.options.accessToken, 'triggers[].options.accessToken');
    requireOptionalBoolean(entry.options.refreshToken, 'triggers[].options.refreshToken');
    if (entry.timeoutSeconds !== undefined) {
      const validTimeout =
        typeof entry.timeoutSeconds === 'number' &&
        Number.isFinite(entry.timeoutSeconds) &&
        entry.timeoutSeconds > 0;
      requireShape(validTimeout, 'triggers[].timeoutSeconds');
    }
  }
}

/** Validate `auth.blockingRespond` op replies from the Functions child. */
export function assertAuthBlockingRespondArguments(message: Record<string, unknown>): void {
  requireString(message.requestId, 'requestId');
  requireRecord(message.outcome, 'outcome');
  requireShape(typeof message.outcome.ok === 'boolean', 'outcome.ok');
  if (message.outcome.ok === true) {
    requireRecord(message.outcome.response, 'outcome.response');
  } else {
    requireRecord(message.outcome.error, 'outcome.error');
    requireString(message.outcome.error.code, 'outcome.error.code');
    requireString(message.outcome.error.status, 'outcome.error.status');
    requireString(message.outcome.error.message, 'outcome.error.message');
  }
}

const VALID_WIRE_SMS_TYPES: ReadonlySet<string> = new Set([
  'SIGN_IN_OR_SIGN_UP',
  'MULTI_FACTOR_SIGN_IN',
  'MULTI_FACTOR_ENROLLMENT',
]);

/** Validate `auth.sendSmsVerification` op payloads. */
export function assertAuthSendSmsArguments(message: Record<string, unknown>): void {
  requireString(message.phoneNumber, 'phoneNumber');
  requireOptionalString(message.uid, 'uid');
  if (message.smsType !== undefined) {
    const validType =
      typeof message.smsType === 'string' && VALID_WIRE_SMS_TYPES.has(message.smsType);
    requireShape(validType, 'smsType');
  }
}

/** Validate `auth.takeSms` op payloads. */
export function assertAuthTakeSmsArguments(message: Record<string, unknown>): void {
  requireOptionalString(message.phoneNumber, 'phoneNumber');
}
