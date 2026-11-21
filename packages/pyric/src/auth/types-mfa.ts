/**
 * Public multi-factor, phone, TOTP, and reCAPTCHA TypeScript declarations for
 * `pyric/auth`, mirroring `@firebase/auth` (`1.13.6`).
 *
 * Runtime classes whose runtime symbols carry deferred dispositions in
 * `packages/conformance/surfaces/auth.json` (`PhoneAuthCredential`,
 * `PhoneAuthProvider`, `PhoneMultiFactorGenerator`, `RecaptchaVerifier`,
 * `TotpMultiFactorGenerator`, `TotpSecret`) are exported as pure TypeScript
 * interfaces so consumers receive exact instance type checking without
 * introducing stubbed runtime constructors.
 */
import type { OperationType } from './enums.js';
import type { FactorId } from './factor-id.js';
import type { UserCredential } from './types.js';
import type { AuthError } from './types-core.js';

/** Verifier for domain verification and abuse prevention (`@firebase/auth`). */
export interface ApplicationVerifier {
  readonly type: string;
  verify(): Promise<string>;
}

/** Result from a phone number sign-in, link, or reauthenticate call (`@firebase/auth`). */
export interface ConfirmationResult {
  readonly verificationId: string;
  confirm(verificationCode: string): Promise<UserCredential>;
}

/** Base interface for asserting ownership of a second factor (`@firebase/auth`). */
export interface MultiFactorAssertion {
  readonly factorId: (typeof FactorId)[keyof typeof FactorId];
}

/** Error raised when a second factor is required to complete sign-in (`@firebase/auth`). */
export interface MultiFactorError extends AuthError {
  readonly customData: AuthError['customData'] & {
    readonly operationType: (typeof OperationType)[keyof typeof OperationType];
  };
}

/** Information describing an enrolled second factor (`@firebase/auth`). */
export interface MultiFactorInfo {
  readonly uid: string;
  readonly displayName?: string | null;
  readonly enrollmentTime: string;
  readonly factorId: (typeof FactorId)[keyof typeof FactorId];
}

/** Session identifier for enrolling or signing in with a second factor (`@firebase/auth`). */
export interface MultiFactorSession {}

/** Helper used to complete sign-in after a `MultiFactorError` (`@firebase/auth`). */
export interface MultiFactorResolver {
  readonly hints: MultiFactorInfo[];
  readonly session: MultiFactorSession;
  resolveSignIn(assertion: MultiFactorAssertion): Promise<UserCredential>;
}

/** Multi-factor properties and operations bound to a `User` (`@firebase/auth`). */
export interface MultiFactorUser {
  readonly enrolledFactors: MultiFactorInfo[];
  getSession(): Promise<MultiFactorSession>;
  enroll(assertion: MultiFactorAssertion, displayName?: string | null): Promise<void>;
  unenroll(option: MultiFactorInfo | string): Promise<void>;
}

/** Instance shape of credentials produced by `PhoneAuthProvider` (`@firebase/auth`). */
export interface PhoneAuthCredential {
  readonly providerId: string;
  readonly signInMethod: string;
  toJSON(): object;
}

/** Options used for single-factor phone sign-in (`@firebase/auth`). */
export interface PhoneSingleFactorInfoOptions {
  phoneNumber: string;
}

/** Options used for enrolling a phone second factor (`@firebase/auth`). */
export interface PhoneMultiFactorEnrollInfoOptions {
  phoneNumber: string;
  session: MultiFactorSession;
}

/** Options used for signing in with a phone second factor (`@firebase/auth`). */
export interface PhoneMultiFactorSignInInfoOptions {
  multiFactorHint?: MultiFactorInfo;
  multiFactorUid?: string;
  session: MultiFactorSession;
}

/** Information required to verify ownership of a phone number (`@firebase/auth`). */
export type PhoneInfoOptions =
  | PhoneSingleFactorInfoOptions
  | PhoneMultiFactorEnrollInfoOptions
  | PhoneMultiFactorSignInInfoOptions;

/** Instance shape of `PhoneAuthProvider` (`@firebase/auth`). */
export interface PhoneAuthProvider {
  readonly providerId: 'phone';
  verifyPhoneNumber(
    phoneOptions: PhoneInfoOptions | string,
    applicationVerifier?: ApplicationVerifier,
  ): Promise<string>;
}

/** Second-factor assertion for a phone factor (`@firebase/auth`). */
export interface PhoneMultiFactorAssertion extends MultiFactorAssertion {}

/** Instance shape of `PhoneMultiFactorGenerator` (`@firebase/auth`). */
export interface PhoneMultiFactorGenerator {}

/** Enrolled second-factor info for a phone number (`@firebase/auth`). */
export interface PhoneMultiFactorInfo extends MultiFactorInfo {
  readonly phoneNumber: string;
}

/** Parameters passed to reCAPTCHA widget rendering (`@firebase/auth`). */
export interface RecaptchaParameters {
  size?: 'normal' | 'compact' | 'invisible' | string;
  theme?: 'light' | 'dark' | string;
  badge?: 'bottomright' | 'bottomleft' | 'inline' | string;
  tabindex?: number;
  callback?: (response: string) => void;
  'expired-callback'?: () => void;
  'error-callback'?: () => void;
  isolated?: boolean;
  [key: string]: unknown;
}

/** Instance shape of a reCAPTCHA-backed `ApplicationVerifier` (`@firebase/auth`). */
export interface RecaptchaVerifier extends ApplicationVerifier {
  readonly type: 'recaptcha';
  verify(): Promise<string>;
  render(): Promise<number>;
  clear(): void;
}

/** Second-factor assertion for a TOTP factor (`@firebase/auth`). */
export interface TotpMultiFactorAssertion extends MultiFactorAssertion {}

/** Instance shape of `TotpMultiFactorGenerator` (`@firebase/auth`). */
export interface TotpMultiFactorGenerator {}

/** Enrolled second-factor info for a TOTP factor (`@firebase/auth`). */
export interface TotpMultiFactorInfo extends MultiFactorInfo {}

/** Shared TOTP secret and enrollment metadata (`@firebase/auth`). */
export interface TotpSecret {
  readonly secretKey: string;
  readonly hashingAlgorithm: string;
  readonly codeLength: number;
  readonly codeIntervalSeconds: number;
  readonly enrollmentCompletionDeadline: string;
  generateQrCodeUrl(accountName?: string, issuer?: string): string;
}
