/**
 * The firebase-admin createToken option inputs the admin-option probes send.
 * Validation cases are refused by firebase-admin itself; the capture records
 * whether each one throws synchronously or rejects, and with what message.
 * Network cases mint real tokens and record only their shape.
 */

export interface ValidationCase {
  key: string;
  appId: 'config' | 'empty';
  /** Deliberately loose: these are the malformed values under test. */
  options: unknown;
}

/** Inputs firebase-admin refuses before or while building the request. */
export function validationCases(runJti: string): ValidationCase[] {
  return [
    { key: 'optionsNull', appId: 'config', options: null },
    { key: 'optionsString', appId: 'config', options: 'str' },
    { key: 'optionsArray', appId: 'config', options: [] },
    { key: 'ttlNull', appId: 'config', options: { ttlMillis: null } },
    { key: 'ttlNaN', appId: 'config', options: { ttlMillis: Number.NaN } },
    { key: 'ttlString', appId: 'config', options: { ttlMillis: '1800000' } },
    { key: 'ttlTooShort', appId: 'config', options: { ttlMillis: 1 } },
    { key: 'appIdEmpty', appId: 'empty', options: undefined },
    { key: 'jtiWithoutLimitedUse', appId: 'config', options: { jti: runJti } },
    { key: 'limitedUseString', appId: 'config', options: { limitedUse: 'yes' } },
    { key: 'jtiNumber', appId: 'config', options: { limitedUse: true, jti: 5 } },
  ];
}

/** Fractional ttlMillis values that production accepts; the capture records how each is rounded. */
export const FRACTIONAL_TTL_CASES = [
  { key: 'ttl1800999', ttlMillis: 1_800_999 },
  { key: 'ttl1800000point5', ttlMillis: 1_800_000.5 },
] as const;
