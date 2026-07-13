/**
 * Passwordless email-link sign-in: `sendSignInLinkToEmail`,
 * `isSignInWithEmailLink`, `signInWithEmailLink`.
 *
 * ─── The flow, and where production becomes unobservable ────────────
 *   1. `sendSignInLinkToEmail(auth, email, settings)` — mails a link.
 *   2. the user opens their inbox and clicks it.        <-- the gap
 *   3. the app boots, `isSignInWithEmailLink(auth, location.href)` is
 *      true, and `signInWithEmailLink(auth, email, link)` signs them in.
 *
 * Step 2 is the gap no test and no probe can cross. Steps 1 and 3 we
 * probed, and captured what production does on the client side of it:
 *
 *   - `isSignInWithEmailLink` is a PURE predicate over the link string —
 *     no network at all. True only for `mode=signIn` WITH an `oobCode`;
 *     false for a reset link, for `mode=signIn` with no code, and for
 *     garbage. Oracle-backed (`auth-issigninwithemaillink-predicate`),
 *     and project-independent because no server is involved.
 *   - `sendSignInLinkToEmail`'s settings contract is validated CLIENT-side
 *     before any request goes out: no `url` -> `auth/invalid-continue-uri`,
 *     `handleCodeInApp: false` -> `auth/argument-error`. Both
 *     oracle-backed (`auth-sendsigninlinktoemail-settings-validation`).
 *   - `signInWithEmailLink` with a link carrying no `oobCode` ->
 *     `auth/argument-error`, thrown client-side. Oracle-backed
 *     (`auth-signinwithemaillink-invalid-link`).
 *
 * What we could NOT observe: the oracle project has email-link sign-in
 * disabled at the project level, so the SERVER arms (`unauthorized-
 * continue-uri` for a non-allowlisted domain, and the redemption of a
 * real code) answered `auth/operation-not-allowed` instead. Those rows
 * are unit-backed and say so.
 *
 * ─── What the sandbox does about the gap ────────────────────────────
 * It hands you the link. `sendSignInLinkToEmail` puts a real message,
 * with a real single-use code, in an outbox; `sandbox.takeAuthMail(auth)`
 * reads it. So the round trip completes in-process:
 *
 *   await sendSignInLinkToEmail(auth, 'ada@example.com', settings);
 *   const mail = authSandbox.takeAuthMail(auth);          // the inbox
 *   await signInWithEmailLink(auth, 'ada@example.com', mail.link);
 *
 * That is not a mock of the outcome — it is the real code, going through
 * the real parse and the real redemption. Only the human is replaced.
 */

import { makeAuthError } from './auth-errors.js';
import { ActionCodeOperation, SignInMethod } from './enums.js';
import { ActionCodeURL } from './action-code-url.js';
import {
  buildActionLink,
  validateActionCodeSettings,
  type ActionCodeSettings,
} from './action-codes.js';
import { targetOf } from './target.js';
import type { Auth, UserCredential } from './types.js';

/**
 * `sendSignInLinkToEmail(auth, email, settings)` — mirror of
 * `firebase/auth`.
 *
 * `settings.url` is REQUIRED and `settings.handleCodeInApp` must be
 * `true` — both enforced client-side, both oracle-pinned (see the file
 * docstring). Unlike `sendPasswordResetEmail`, this one does NOT require
 * an existing account: sending a sign-in link to an unknown address is
 * the sign-UP path, and the account is created when the link is redeemed.
 */
export async function sendSignInLinkToEmail(
  auth: Auth,
  email: string,
  settings: ActionCodeSettings,
): Promise<void> {
  const t = targetOf(auth);
  const target = t;
  validateActionCodeSettings(settings, 'sendSignInLinkToEmail');
  // Oracle: `handleCodeInAppFalse: 'auth/argument-error'`. Upstream
  // requires it be true for this flow specifically — the whole point is
  // that the APP completes the sign-in, not a hosted web widget.
  if (settings.handleCodeInApp !== true) {
    throw makeAuthError(
      'auth/argument-error',
      'sendSignInLinkToEmail: handleCodeInApp must be true when sending a sign-in link to an email.',
    );
  }
  assertEmail(email, 'sendSignInLinkToEmail');
  const code = target.backend.mintActionCode({
    operation: ActionCodeOperation.EMAIL_SIGNIN,
    email,
  });
  target.backend.deliverMail({
    operation: ActionCodeOperation.EMAIL_SIGNIN,
    email,
    code,
    link: buildActionLink('signIn', code, settings.url),
  });
}

/**
 * `isSignInWithEmailLink(auth, link)` — mirror of `firebase/auth`.
 *
 * A pure predicate over the string: no network, no project, no state.
 * True iff the link parses AND its operation is `EMAIL_SIGNIN`. Never
 * throws — garbage in, `false` out. Oracle-pinned on all five cases the
 * capture covers.
 *
 * `auth` is unused (upstream takes it for signature symmetry and tenant
 * plumbing, neither of which changes the answer) but is kept in the
 * signature so consumer code is identical across the two SDKs.
 */
export function isSignInWithEmailLink(auth: Auth, link: string): boolean {
  targetOf(auth);
  const parsed = ActionCodeURL.parseLink(link);
  return parsed !== null && parsed.operation === ActionCodeOperation.EMAIL_SIGNIN;
}

/**
 * `signInWithEmailLink(auth, email, link)` — mirror of `firebase/auth`.
 * Redeems the code in the link and signs the user in.
 *
 * Creates the account if the address is new — a first-time email-link
 * sign-in IS a sign-up, and `getAdditionalUserInfo(cred).isNewUser`
 * reports it honestly. Either way the account comes out `emailVerified:
 * true`, because redeeming a code that was mailed to that address is
 * proof the user controls it. (An account born this way has NO password:
 * `signInWithEmailAndPassword` against it fails until one is set, exactly
 * as in prod.)
 *
 * Throws `auth/argument-error` for a link with no `oobCode`
 * (oracle-backed), and `auth/invalid-action-code` for a code the sandbox
 * never issued or that has already been redeemed (single-use).
 */
export async function signInWithEmailLink(
  auth: Auth,
  email: string,
  link: string,
): Promise<UserCredential> {
  const t = targetOf(auth);
  const target = t;
  target.backend.assertProviderEnabled('password');
  const parsed = ActionCodeURL.parseLink(link);
  if (!parsed) {
    // Oracle: a `mode=signIn` link with no oobCode throws
    // `auth/argument-error` client-side, NOT invalid-action-code — the
    // SDK never gets far enough to ask the server about a code it cannot
    // find in the link.
    throw makeAuthError(
      'auth/argument-error',
      'signInWithEmailLink: the link is not a valid email sign-in link (no oobCode).',
    );
  }
  if (parsed.operation !== ActionCodeOperation.EMAIL_SIGNIN) {
    throw makeAuthError(
      'auth/argument-error',
      `signInWithEmailLink: the link authorizes ${parsed.operation}, not an email sign-in.`,
    );
  }
  assertEmail(email, 'signInWithEmailLink');

  const spec = target.backend.peekActionCode(parsed.code);
  if (!spec) {
    throw makeAuthError(
      'auth/invalid-action-code',
      'signInWithEmailLink: the action code is invalid. This can happen if the code is malformed, expired, or has already been used.',
    );
  }
  if (spec.expired) {
    throw makeAuthError('auth/expired-action-code', 'signInWithEmailLink: the action code has expired.');
  }
  // The address the caller passed must be the one the link was issued
  // for. This is the check that makes the flow safe against a link
  // pasted into the wrong session — upstream requires the caller to
  // supply the email precisely so it can be compared.
  if (spec.email.toLowerCase() !== email.toLowerCase()) {
    throw makeAuthError(
      'auth/invalid-email',
      'signInWithEmailLink: the email provided does not match the address this sign-in link was issued for.',
    );
  }

  target.backend.consumeActionCode(parsed.code);
  const { stored, isNewUser } = target.backend.upsertEmailLinkUser(spec.email);
  target.backend.assertSignInAllowed(stored.uid);
  const user = target.backend.buildUserFromStored(stored);
  await target.backend.transitionCurrentUser(user, 'password');
  return {
    user,
    // Email/password sign-ins carry `providerId: null` on the credential
    // — the same oracle-pinned rule `signInWithEmailAndPassword` follows
    // (observations/auth/auth-createUser-operationType.json).
    providerId: null,
    operationType: 'signIn',
    _additionalUserInfo: {
      isNewUser,
      profile: {},
      providerId: null,
    },
  };
}

/** The email-link sign-in method id, for symmetry with
 *  `EmailAuthProvider.EMAIL_LINK_SIGN_IN_METHOD`. */
export const EMAIL_LINK_SIGN_IN_METHOD = SignInMethod.EMAIL_LINK;

function assertEmail(email: string, api: string): void {
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw makeAuthError('auth/invalid-email', `${api}: the email address is badly formatted.`);
  }
}
