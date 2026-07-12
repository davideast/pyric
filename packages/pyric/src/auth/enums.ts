/**
 * The constant maps of the `firebase/auth` surface — `ProviderId`,
 * `SignInMethod`, `OperationType`, `ActionCodeOperation`, and
 * `AuthErrorCodes`.
 *
 * ─── Why these are DATA, not behavior ──────────────────────────────
 * Consumer code compares against these constants
 * (`cred.operationType === OperationType.LINK`,
 * `info.providerId === ProviderId.GOOGLE`,
 * `err.code === AuthErrorCodes.PROVIDER_ALREADY_LINKED`). A mirror that
 * reproduces the API but not the exact STRINGS turns every such
 * comparison into a silent false — a failure mode worse than the export
 * simply being absent, because it typechecks and runs.
 *
 * So the values here are not paraphrased from documentation. They are
 * transcribed from a snapshot of the shipped SDK's own maps, captured by
 * the `auth-mechanical-surface-constants` oracle probe against
 * firebase-js-sdk 12.13.0, and the `oracle-conformance` suite replays
 * that observation against these objects — if upstream ever renumbers a
 * value, the capture and the suite disagree and the build fails.
 *
 * `AuthErrorCodes` is re-exported from `firebase/auth` rather than
 * retyped: it is a ~90-entry map of pure string constants with no
 * sandbox/prod split, and hand-copying it would be a decay surface with
 * no upside. `pyric/auth` already depends on `firebase/auth` for the
 * prod backend, so this costs nothing new.
 */

import { AuthErrorCodes as fbAuthErrorCodes } from 'firebase/auth';

/**
 * Aggregate provider ids. Mirrors `firebase/auth`'s `ProviderId`.
 *
 * Note the shape upstream chose: the anonymous and custom-token sign-in
 * paths have NO entry here (they are not federated identity providers),
 * which is why {@link UserCredential.providerId} is `null` for both.
 */
export const ProviderId = {
  FACEBOOK: 'facebook.com',
  GITHUB: 'github.com',
  GOOGLE: 'google.com',
  PASSWORD: 'password',
  PHONE: 'phone',
  TWITTER: 'twitter.com',
} as const;
export type ProviderId = (typeof ProviderId)[keyof typeof ProviderId];

/**
 * Sign-in method ids. Mirrors `firebase/auth`'s `SignInMethod`.
 *
 * Distinct from {@link ProviderId} precisely because one provider can
 * carry several methods: `EmailAuthProvider` (`'password'`) signs in
 * with EITHER `EMAIL_PASSWORD` (`'password'`) or `EMAIL_LINK`
 * (`'emailLink'`). That split is what `AuthCredential.signInMethod`
 * discriminates, and it is what the email-link family turns on.
 */
export const SignInMethod = {
  EMAIL_LINK: 'emailLink',
  EMAIL_PASSWORD: 'password',
  FACEBOOK: 'facebook.com',
  GITHUB: 'github.com',
  GOOGLE: 'google.com',
  PHONE: 'phone',
  TWITTER: 'twitter.com',
} as const;
export type SignInMethod = (typeof SignInMethod)[keyof typeof SignInMethod];

/**
 * What produced a `UserCredential`. Mirrors `firebase/auth`'s
 * `OperationType` — the discriminant `signInWith*` / `linkWith*` /
 * `reauthenticateWith*` set on their results.
 *
 * `SIGN_IN` is `'signIn'`, NOT `'register'`: a fresh
 * `createUserWithEmailAndPassword` also reports `'signIn'`. Oracle:
 * `observations/auth/auth-createUser-operationType.json`.
 */
export const OperationType = {
  LINK: 'link',
  REAUTHENTICATE: 'reauthenticate',
  SIGN_IN: 'signIn',
} as const;
export type OperationType = (typeof OperationType)[keyof typeof OperationType];

/**
 * The operation an out-of-band action code authorizes. Mirrors
 * `firebase/auth`'s `ActionCodeOperation` — the value
 * {@link ActionCodeURL.operation} carries and {@link checkActionCode}
 * returns.
 *
 * These are the SDK's normalized names, not the `mode` query param that
 * appears in the link: a link carrying `mode=resetPassword` parses to
 * operation `'PASSWORD_RESET'`, and `mode=signIn` parses to
 * `'EMAIL_SIGNIN'`. Oracle:
 * `observations/auth/auth-actioncodeurl-parse.json` captured both
 * mappings against firebase-js-sdk 12.13.0.
 */
export const ActionCodeOperation = {
  EMAIL_SIGNIN: 'EMAIL_SIGNIN',
  PASSWORD_RESET: 'PASSWORD_RESET',
  RECOVER_EMAIL: 'RECOVER_EMAIL',
  REVERT_SECOND_FACTOR_ADDITION: 'REVERT_SECOND_FACTOR_ADDITION',
  VERIFY_AND_CHANGE_EMAIL: 'VERIFY_AND_CHANGE_EMAIL',
  VERIFY_EMAIL: 'VERIFY_EMAIL',
} as const;
export type ActionCodeOperation = (typeof ActionCodeOperation)[keyof typeof ActionCodeOperation];

/**
 * The full `auth/*` error-code map. Re-exported verbatim from
 * `firebase/auth` — see the file docstring for why this one is
 * re-exported rather than retyped.
 */
export const AuthErrorCodes = fbAuthErrorCodes;
