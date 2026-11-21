/**
 * Blocking response validation, `HttpsError` normalization, and trigger
 * invocation for `firebase-functions/v2/identity` (`7.2.5`).
 *
 * Matches `lib/common/providers/identity.js` (`validateAuthResponse`,
 * `generateResponsePayload`, and `HttpsError.toJSON`).
 */
import type { DiscoveredIdentityTrigger, IdentityShortEventType } from './discovery.js';
import {
  buildAuthBlockingEvent,
  buildAuthBlockingJwt,
  type BuildAuthBlockingEventOptions,
} from './event.js';

type RecaptchaActionOption = 'ALLOW' | 'BLOCK';

/**
 * Reserved claim names rejected in `customClaims` and `sessionClaims`
 * (`DISALLOWED_CUSTOM_CLAIMS` in `firebase-functions` plus `sub` per Firebase Auth).
 */
export const DISALLOWED_BLOCKING_CLAIMS: readonly string[] = [
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
  'firebase',
];

export const CLAIMS_MAX_PAYLOAD_SIZE = 1000;

const GRPC_ERROR_CODES: Readonly<
  Record<string, { readonly canonicalName: string; readonly status: number }>
> = {
  ok: { canonicalName: 'OK', status: 200 },
  cancelled: { canonicalName: 'CANCELLED', status: 499 },
  unknown: { canonicalName: 'UNKNOWN', status: 500 },
  'invalid-argument': { canonicalName: 'INVALID_ARGUMENT', status: 400 },
  'deadline-exceeded': { canonicalName: 'DEADLINE_EXCEEDED', status: 504 },
  'not-found': { canonicalName: 'NOT_FOUND', status: 404 },
  'already-exists': { canonicalName: 'ALREADY_EXISTS', status: 409 },
  'permission-denied': { canonicalName: 'PERMISSION_DENIED', status: 403 },
  unauthenticated: { canonicalName: 'UNAUTHENTICATED', status: 401 },
  'resource-exhausted': { canonicalName: 'RESOURCE_EXHAUSTED', status: 429 },
  'failed-precondition': { canonicalName: 'FAILED_PRECONDITION', status: 400 },
  aborted: { canonicalName: 'ABORTED', status: 409 },
  'out-of-range': { canonicalName: 'OUT_OF_RANGE', status: 400 },
  unimplemented: { canonicalName: 'UNIMPLEMENTED', status: 501 },
  internal: { canonicalName: 'INTERNAL', status: 500 },
  unavailable: { canonicalName: 'UNAVAILABLE', status: 503 },
  'data-loss': { canonicalName: 'DATA_LOSS', status: 500 },
};

const CANONICAL_TO_CLIENT_CODE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(GRPC_ERROR_CODES).map(([code, entry]) => [entry.canonicalName, code]),
);

export interface IdentityBlockingResponsePayload {
  displayName?: string;
  disabled?: boolean;
  emailVerified?: boolean;
  photoURL?: string;
  customClaims?: Record<string, unknown>;
  sessionClaims?: Record<string, unknown>;
  recaptchaActionOverride?: RecaptchaActionOption;
}

export interface NormalizedBlockingHttpsError {
  code: string;
  status: string;
  httpStatus: number;
  message: string;
  details?: unknown;
}

export type IdentityExecutionResult =
  | {
      status: 'fulfilled';
      event: Record<string, unknown>;
      response: IdentityBlockingResponsePayload;
      wirePayload: Record<string, unknown>;
    }
  | {
      status: 'rejected';
      event: Record<string, unknown>;
      error: NormalizedBlockingHttpsError;
      rawError: unknown;
    };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function makeHttpsLikeError(code: string, message: string, details?: unknown): Error {
  const mapped = GRPC_ERROR_CODES[code] ?? GRPC_ERROR_CODES.internal;
  const err = new Error(message) as Error & {
    code: string;
    details?: unknown;
    httpErrorCode: { canonicalName: string; status: number };
    toJSON(): Record<string, unknown>;
  };
  err.code = code;
  err.details = details;
  err.httpErrorCode = {
    canonicalName: mapped?.canonicalName ?? 'INTERNAL',
    status: mapped?.status ?? 500,
  };
  err.toJSON = () => {
    const out: Record<string, unknown> = {
      message: err.message,
      status: err.httpErrorCode.canonicalName,
    };
    if (err.details !== undefined) out.details = err.details;
    return out;
  };
  return err;
}

function validateClaimsObject(
  claims: unknown,
  fieldName: 'customClaims' | 'sessionClaims',
): Record<string, unknown> {
  if (!isPlainRecord(claims)) {
    throw makeHttpsLikeError(
      'invalid-argument',
      `The ${fieldName} payload must be a plain object.`,
    );
  }
  const invalid = DISALLOWED_BLOCKING_CLAIMS.filter((claim) =>
    Object.prototype.hasOwnProperty.call(claims, claim),
  );
  if (invalid.length > 0) {
    throw makeHttpsLikeError(
      'invalid-argument',
      `The ${fieldName} claims "${invalid.join(',')}" are reserved and cannot be specified.`,
    );
  }
  if (JSON.stringify(claims).length > CLAIMS_MAX_PAYLOAD_SIZE) {
    throw makeHttpsLikeError(
      'invalid-argument',
      `The ${fieldName} payload should not exceed ${CLAIMS_MAX_PAYLOAD_SIZE} characters.`,
    );
  }
  return structuredClone(claims);
}

/** Validate and normalize a blocking handler's returned response object. */
export function validateIdentityBlockingResponse(
  shortEventType: IdentityShortEventType,
  rawResponse: unknown,
): { response: IdentityBlockingResponsePayload; wirePayload: Record<string, unknown> } {
  if (rawResponse === undefined || rawResponse === null) {
    return { response: {}, wirePayload: {} };
  }
  if (!isPlainRecord(rawResponse)) {
    throw makeHttpsLikeError('internal', 'An unexpected error occurred.');
  }
  const response: IdentityBlockingResponsePayload = {};
  if (rawResponse.displayName !== undefined) {
    if (typeof rawResponse.displayName !== 'string') {
      throw makeHttpsLikeError('invalid-argument', 'displayName must be a string.');
    }
    response.displayName = rawResponse.displayName;
  }
  if (rawResponse.disabled !== undefined) {
    if (typeof rawResponse.disabled !== 'boolean') {
      throw makeHttpsLikeError('invalid-argument', 'disabled must be a boolean.');
    }
    response.disabled = rawResponse.disabled;
  }
  if (rawResponse.emailVerified !== undefined) {
    if (typeof rawResponse.emailVerified !== 'boolean') {
      throw makeHttpsLikeError('invalid-argument', 'emailVerified must be a boolean.');
    }
    response.emailVerified = rawResponse.emailVerified;
  }
  if (rawResponse.photoURL !== undefined) {
    if (typeof rawResponse.photoURL !== 'string') {
      throw makeHttpsLikeError('invalid-argument', 'photoURL must be a string.');
    }
    response.photoURL = rawResponse.photoURL;
  }
  if (rawResponse.customClaims !== undefined) {
    response.customClaims = validateClaimsObject(rawResponse.customClaims, 'customClaims');
  }
  if (shortEventType === 'beforeSignIn' && rawResponse.sessionClaims !== undefined) {
    response.sessionClaims = validateClaimsObject(rawResponse.sessionClaims, 'sessionClaims');
    const combined = {
      ...(response.customClaims ?? {}),
      ...response.sessionClaims,
    };
    if (JSON.stringify(combined).length > CLAIMS_MAX_PAYLOAD_SIZE) {
      throw makeHttpsLikeError(
        'invalid-argument',
        `The customClaims and sessionClaims payloads should not exceed ${CLAIMS_MAX_PAYLOAD_SIZE} characters combined.`,
      );
    }
  }
  if (rawResponse.recaptchaActionOverride !== undefined) {
    if (
      rawResponse.recaptchaActionOverride !== 'ALLOW' &&
      rawResponse.recaptchaActionOverride !== 'BLOCK'
    ) {
      throw makeHttpsLikeError(
        'invalid-argument',
        'recaptchaActionOverride must be "ALLOW" or "BLOCK".',
      );
    }
    response.recaptchaActionOverride = rawResponse.recaptchaActionOverride;
  }

  const updateMaskKeys: string[] = [];
  const userRecordOut: Record<string, unknown> = {};
  for (const key of [
    'displayName',
    'disabled',
    'emailVerified',
    'photoURL',
    'customClaims',
    'sessionClaims',
  ] as const) {
    if (response[key] !== undefined) {
      updateMaskKeys.push(key);
      userRecordOut[key] = response[key];
    }
  }
  const wirePayload: Record<string, unknown> = {};
  if (updateMaskKeys.length > 0) {
    userRecordOut.updateMask = updateMaskKeys.join(',');
    wirePayload.userRecord = userRecordOut;
  }
  if (response.recaptchaActionOverride !== undefined) {
    wirePayload.recaptchaActionOverride = response.recaptchaActionOverride;
  }
  return { response, wirePayload };
}

/** Normalize any thrown error (CJS/ESM `HttpsError` or unexpected Error) fail-closed. */
export function normalizeIdentityBlockingError(error: unknown): NormalizedBlockingHttpsError {
  if (isPlainRecord(error)) {
    let rawCode: string | undefined;
    if (typeof error.code === 'string') {
      rawCode = error.code;
    }
    let httpErrorCode: Record<string, unknown> | undefined;
    if (isPlainRecord(error.httpErrorCode)) {
      httpErrorCode = error.httpErrorCode;
    }
    let canonicalFromHttp: string | undefined;
    if (typeof httpErrorCode?.canonicalName === 'string') {
      canonicalFromHttp = httpErrorCode.canonicalName;
    }
    let resolvedClientCode: string | undefined;
    if (rawCode !== undefined && rawCode in GRPC_ERROR_CODES) {
      resolvedClientCode = rawCode;
    } else if (canonicalFromHttp !== undefined) {
      resolvedClientCode = CANONICAL_TO_CLIENT_CODE[canonicalFromHttp];
    }
    if (resolvedClientCode !== undefined) {
      const entry = GRPC_ERROR_CODES[resolvedClientCode];
      let message = '';
      if (typeof error.message === 'string') {
        message = error.message;
      }
      const normalized: NormalizedBlockingHttpsError = {
        code: resolvedClientCode,
        status: entry?.canonicalName ?? 'INTERNAL',
        httpStatus: entry?.status ?? 500,
        message,
      };
      if ('details' in error && error.details !== undefined) {
        normalized.details = error.details;
      }
      return normalized;
    }
  }
  return {
    code: 'internal',
    status: 'INTERNAL',
    httpStatus: 500,
    message: 'An unexpected error occurred.',
  };
}

async function invokeExpressBlockingHandler(
  handler: (req: Record<string, unknown>, res: Record<string, unknown>) => unknown,
  jwt: string,
): Promise<unknown> {
  let statusCode = 200;
  let sentBody: unknown;
  const headers = new Map<string, string>([['content-type', 'application/json']]);
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    header(name: string): string | undefined {
      return headers.get(name.toLowerCase());
    },
    body: { data: { jwt } },
  };
  let resolveSend: (() => void) | undefined;
  const sentPromise = new Promise<void>((resolve) => {
    resolveSend = resolve;
  });
  const res: Record<string, unknown> = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    setHeader(_name: string, _value: string) {
      return res;
    },
    send(body: unknown) {
      sentBody = body;
      resolveSend?.();
      return res;
    },
    json(body: unknown) {
      sentBody = body;
      resolveSend?.();
      return res;
    },
  };
  await Promise.race([Promise.resolve(handler(req, res)), sentPromise]);
  let parsedBody: unknown = sentBody;
  if (typeof sentBody === 'string' && sentBody.length > 0) {
    parsedBody = JSON.parse(sentBody) as unknown;
  }
  if (statusCode >= 400) {
    let errorEnvelope: Record<string, unknown> | undefined;
    if (isPlainRecord(parsedBody) && isPlainRecord(parsedBody.error)) {
      errorEnvelope = parsedBody.error;
    }
    let rawStatus = 'INTERNAL';
    if (typeof errorEnvelope?.status === 'string') {
      rawStatus = errorEnvelope.status;
    }
    const clientCode = CANONICAL_TO_CLIENT_CODE[rawStatus] ?? 'internal';
    let message = 'An unexpected error occurred.';
    if (typeof errorEnvelope?.message === 'string') {
      message = errorEnvelope.message;
    }
    throw makeHttpsLikeError(clientCode, message, errorEnvelope?.details);
  }
  if (isPlainRecord(parsedBody)) {
    const out: Record<string, unknown> = {};
    if (isPlainRecord(parsedBody.userRecord)) {
      for (const [key, value] of Object.entries(parsedBody.userRecord)) {
        if (key !== 'updateMask') {
          out[key] = value;
        }
      }
    }
    if (parsedBody.recaptchaActionOverride !== undefined) {
      out.recaptchaActionOverride = parsedBody.recaptchaActionOverride;
    }
    return out;
  }
  return undefined;
}

/** Execute a discovered Identity blocking trigger against an encoded event. */
export async function executeIdentityTrigger(
  trigger: DiscoveredIdentityTrigger,
  input: Omit<BuildAuthBlockingEventOptions, 'eventType' | 'blockingOptions'>,
  options: { ensureInitialized?: () => Promise<void> } = {},
): Promise<IdentityExecutionResult> {
  const fullOptions: BuildAuthBlockingEventOptions = {
    ...input,
    eventType: trigger.eventType,
    blockingOptions: trigger.options,
  };
  const event = buildAuthBlockingEvent(fullOptions);
  try {
    if (options.ensureInitialized !== undefined) {
      await options.ensureInitialized();
    }
    let rawResponse: unknown;
    if (typeof trigger.callable.run === 'function') {
      rawResponse = await trigger.callable.run(event);
    } else if (trigger.callable.length >= 2) {
      const jwt = buildAuthBlockingJwt(fullOptions);
      rawResponse = await invokeExpressBlockingHandler(
        trigger.callable as (req: Record<string, unknown>, res: Record<string, unknown>) => unknown,
        jwt,
      );
    } else {
      const directRunner = trigger.callable as (ev: Record<string, unknown>) => unknown;
      rawResponse = await directRunner(event);
    }
    const { response, wirePayload } = validateIdentityBlockingResponse(
      trigger.shortEventType,
      rawResponse,
    );
    return { status: 'fulfilled', event, response, wirePayload };
  } catch (rawError) {
    return {
      status: 'rejected',
      event,
      error: normalizeIdentityBlockingError(rawError),
      rawError,
    };
  }
}
