/**
 * `validatePassword` and the password-policy types.
 *
 * ─── Oracle-backed, and it agreed with what we already enforced ─────
 * `auth-validatepassword-status-shape` captured production's
 * `PasswordValidationStatus` against the real project:
 *
 *   'x'                             -> isValid: false,
 *                                      meetsMinPasswordLength: false,
 *                                      meetsMaxPasswordLength: true
 *   'aReasonablyStrongPassword123!' -> isValid: true, both length checks true
 *   policy: minPasswordLength 6, maxPasswordLength 4096,
 *           enforcementState 'ENFORCE',
 *           every character-class requirement UNSET
 *
 * The 6-character minimum is the same threshold the sandbox already
 * enforced on `createUserWithEmailAndPassword` (oracle-pinned separately,
 * as `auth/weak-password`), so `validatePassword` and the create path
 * agree here exactly as they do in prod — a password this function calls
 * valid is one `createUserWithEmailAndPassword` will accept, and vice
 * versa. That consistency is the property worth having.
 */

import { requireSandboxTarget } from './action-codes.js';
import type { Auth } from './types.js';

/** Mirror of `firebase/auth`'s `PasswordPolicy`. */
export interface PasswordPolicy {
  readonly customStrengthOptions: {
    readonly minPasswordLength?: number;
    readonly maxPasswordLength?: number;
    readonly containsLowercaseLetter?: boolean;
    readonly containsUppercaseLetter?: boolean;
    readonly containsNumericCharacter?: boolean;
    readonly containsNonAlphanumericCharacter?: boolean;
  };
  readonly allowedNonAlphanumericCharacters: string;
  /** `'ENFORCE'` or `'OFF'`. */
  readonly enforcementState: string;
  readonly forceUpgradeOnSignin: boolean;
}

/** Mirror of `firebase/auth`'s `PasswordValidationStatus`. */
export interface PasswordValidationStatus {
  readonly isValid: boolean;
  readonly meetsMinPasswordLength?: boolean;
  readonly meetsMaxPasswordLength?: boolean;
  readonly containsLowercaseLetter?: boolean;
  readonly containsUppercaseLetter?: boolean;
  readonly containsNumericCharacter?: boolean;
  readonly containsNonAlphanumericCharacter?: boolean;
  readonly passwordPolicy: PasswordPolicy;
}

/**
 * The sandbox's password policy. Values transcribed from the oracle
 * capture of the real project's live policy (see the file docstring), so
 * a sandbox-side length check and a prod-side one draw the same line.
 *
 * The character-class requirements are deliberately UNSET, not `false`:
 * upstream distinguishes "not required" (absent from the status) from
 * "required and unmet" (`false`), and the captured production policy has
 * them absent. A mirror that reported `false` would be telling consumer
 * code the password FAILED a rule the project never had.
 */
const SANDBOX_PASSWORD_POLICY: PasswordPolicy = {
  customStrengthOptions: {
    minPasswordLength: 6,
    maxPasswordLength: 4096,
  },
  allowedNonAlphanumericCharacters: '!@#$%^&*()-_=+[]{}|;:,.<>?/~`"\'\\',
  enforcementState: 'ENFORCE',
  forceUpgradeOnSignin: false,
};

/**
 * `validatePassword(auth, password)` — mirror of `firebase/auth`.
 *
 * Checks a password against the project policy WITHOUT attempting a
 * sign-up, so a UI can show live strength feedback as the user types.
 * Returns the same `PasswordValidationStatus` shape prod returns, with
 * only the requirements the policy actually sets — see the note on
 * {@link SANDBOX_PASSWORD_POLICY} about why unset is not `false`.
 */
export async function validatePassword(
  auth: Auth,
  password: string,
): Promise<PasswordValidationStatus> {
  requireSandboxTarget(auth, 'validatePassword');
  const opts = SANDBOX_PASSWORD_POLICY.customStrengthOptions;
  const min = opts.minPasswordLength ?? 0;
  const max = opts.maxPasswordLength ?? Number.MAX_SAFE_INTEGER;
  const len = typeof password === 'string' ? password.length : 0;
  const meetsMinPasswordLength = len >= min;
  const meetsMaxPasswordLength = len <= max;
  return {
    isValid: meetsMinPasswordLength && meetsMaxPasswordLength,
    meetsMinPasswordLength,
    meetsMaxPasswordLength,
    passwordPolicy: SANDBOX_PASSWORD_POLICY,
  };
}
