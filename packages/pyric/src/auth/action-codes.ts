/**
 * The out-of-band action-code family: the four APIs that SEND a code and
 * the four that REDEEM one.
 *
 *   send    — sendEmailVerification, sendPasswordResetEmail,
 *             verifyBeforeUpdateEmail
 *   redeem  — applyActionCode, checkActionCode, verifyPasswordResetCode,
 *             confirmPasswordReset
 *
 * ─── What production actually does, and what we could observe ───────
 * These flows have a step no program can take: a human opens an inbox
 * and clicks a link. We probed production for everything on THIS side of
 * that gap and captured it under `observations/auth/`:
 *
 *   - `applyActionCode` with a code the project never issued throws
 *     `auth/invalid-action-code` (auth-action-code-invalid). Oracle-backed.
 *   - `sendEmailVerification` on an ANONYMOUS user (no email on the
 *     account) throws `auth/missing-email` (auth-sendemailverification-shape).
 *     Oracle-backed.
 *   - `sendPasswordResetEmail` for an address no account owns RESOLVES,
 *     it does not throw — Email Enumeration Protection is on by default
 *     and refusing to leak account existence is the point. A malformed
 *     address still throws `auth/invalid-email`
 *     (auth-sendpasswordresetemail-unknown-user). Oracle-backed.
 *
 * And what we could NOT observe, stated plainly rather than guessed:
 * the oracle project has the Email/Password provider DISABLED, so
 * `checkActionCode` / `verifyPasswordResetCode` / `confirmPasswordReset`
 * answered `auth/operation-not-allowed` — the provider gate replying
 * before the invalid-code contract could. Their `auth/invalid-action-code`
 * behavior here is therefore UNIT-BACKED and matched to
 * `AuthErrorCodes.INVALID_OOB_CODE` (itself oracle-captured), not
 * oracle-backed. The registry rows say so.
 *
 * ─── The sandbox's model ────────────────────────────────────────────
 * The sandbox IS the mail server. A send mints a real, single-use code,
 * builds the real link, and drops the message in an outbox the caller can
 * read (`sandbox.takeAuthMail`). A redeem takes that same code and
 * performs the real state change. So the round trip that production
 * cannot complete without a human, the sandbox completes in-process —
 * which is the entire reason these APIs are mockable at all.
 */

import { makeAuthError } from './auth-errors.js';
import { ActionCodeOperation } from './enums.js';
import { targetOf } from './target.js';
import type { SandboxTarget } from './target.js';
import type { Auth, User } from './types.js';
import { USER_INTERNAL, type UserInternal } from './types.js';
import type { AuthActionCode } from './sandbox-auth-flow.js';

/**
 * `ActionCodeSettings` — mirror of `firebase/auth`. The continue-URL
 * contract for a mailed link.
 */
export interface ActionCodeSettings {
  /** Where the link sends the user when they click it. REQUIRED. */
  url: string;
  /** Handle the code inside the app rather than on the web widget.
   *  REQUIRED (`true`) for `sendSignInLinkToEmail`. */
  handleCodeInApp?: boolean;
  iOS?: { bundleId: string };
  android?: { packageName: string; installApp?: boolean; minimumVersion?: string };
  /** Deprecated upstream alias of the Hosting link domain. */
  dynamicLinkDomain?: string;
  linkDomain?: string;
}

/**
 * What `checkActionCode` returns. Mirror of `firebase/auth`'s
 * `ActionCodeInfo`.
 */
export interface ActionCodeInfo {
  data: {
    /** The account the code acts on. */
    email?: string | null;
    /** For `VERIFY_AND_CHANGE_EMAIL`: the address being moved AWAY from. */
    previousEmail?: string | null;
    multiFactorInfo?: null;
  };
  /** One of {@link ActionCodeOperation}. */
  operation: string;
}

// ─── Continue-URL validation ──────────────────────────────────────────

/**
 * Validate an {@link ActionCodeSettings}. Oracle-pinned on both arms
 * that are CLIENT-side (and therefore project-independent):
 *
 *   - no `url` at all -> `auth/invalid-continue-uri`. Note this is NOT
 *     `auth/missing-continue-uri`, which is what the code name suggests
 *     and what we expected: the capture
 *     (auth-sendsigninlinktoemail-settings-validation) says prod emits
 *     `invalid-continue-uri` for a missing url. Written to match the
 *     observation, not the guess.
 *   - a `url` that is not parseable -> `auth/invalid-continue-uri`.
 *
 * `auth/unauthorized-continue-uri` (the domain-allowlist arm) is a
 * SERVER-side check against the project's authorized domains. The
 * sandbox has no domain allowlist to check against and does not invent
 * one — it accepts any parseable continue URL. Documented divergence.
 */
export function validateActionCodeSettings(settings: ActionCodeSettings | undefined, api: string): void {
  const url = settings?.url;
  if (typeof url !== 'string' || url.length === 0) {
    throw makeAuthError(
      'auth/invalid-continue-uri',
      `${api}: the continue URL provided in the request is invalid.`,
    );
  }
  try {
    new URL(url);
  } catch {
    throw makeAuthError(
      'auth/invalid-continue-uri',
      `${api}: the continue URL provided in the request is invalid.`,
    );
  }
}

/**
 * Build the action link a message carries. Same query-param shape
 * production uses, so the link this produces round-trips through
 * {@link parseActionCodeURL} and {@link isSignInWithEmailLink}
 * unchanged — which is what makes the sandbox's mail a real substitute
 * for the real one.
 */
export function buildActionLink(
  mode: string,
  code: string,
  continueUrl: string | null,
): string {
  // A sandbox-local default when the caller supplied no continue URL
  // (the reset/verify APIs make settings optional).
  const base = continueUrl ?? 'https://sandbox.pyric.dev/__/auth/action';
  const url = new URL(base);
  url.searchParams.set('mode', mode);
  url.searchParams.set('oobCode', code);
  url.searchParams.set('apiKey', 'sandbox-api-key');
  if (continueUrl) url.searchParams.set('continueUrl', continueUrl);
  return url.toString();
}

/** The `mode` query param for each operation — the inverse of the
 *  parser's map. */
export const OPERATION_TO_MODE: Record<string, string> = {
  [ActionCodeOperation.PASSWORD_RESET]: 'resetPassword',
  [ActionCodeOperation.VERIFY_EMAIL]: 'verifyEmail',
  [ActionCodeOperation.EMAIL_SIGNIN]: 'signIn',
  [ActionCodeOperation.VERIFY_AND_CHANGE_EMAIL]: 'verifyAndChangeEmail',
  [ActionCodeOperation.RECOVER_EMAIL]: 'recoverEmail',
};

// ─── Sending ──────────────────────────────────────────────────────────

/**
 * `sendPasswordResetEmail(auth, email, settings?)` — mirror of
 * `firebase/auth`.
 *
 * Resolves for an address no account owns, WITHOUT throwing and without
 * mailing anything. That is not laziness: it is Email Enumeration
 * Protection, and the oracle confirmed prod behaves exactly this way
 * (`auth-sendpasswordresetemail-unknown-user`:
 * `resolvedForUnknownUser: true`). A shim that threw
 * `auth/user-not-found` here would hand agent code a working account
 * oracle that production deliberately took away.
 *
 * A malformed address still throws `auth/invalid-email` — also
 * oracle-confirmed.
 */
export async function sendPasswordResetEmail(
  auth: Auth,
  email: string,
  settings?: ActionCodeSettings,
): Promise<void> {
  const t = targetOf(auth);
  const target = t;
  if (settings) validateActionCodeSettings(settings, 'sendPasswordResetEmail');
  assertEmailFormat(email, 'sendPasswordResetEmail');
  const stored = target.backend.findByEmail(email);
  if (!stored) {
    // Enumeration protection: resolve silently. No mail, no code, no tell.
    return;
  }
  emit(target, {
    operation: ActionCodeOperation.PASSWORD_RESET,
    email: stored.email ?? email,
  }, settings);
}

/**
 * `sendEmailVerification(user, settings?)` — mirror of `firebase/auth`.
 *
 * Throws `auth/missing-email` for a user with no email on the account
 * (an anonymous user). Oracle-backed:
 * `auth-sendemailverification-shape` captured exactly that code against
 * prod for an anonymous user.
 *
 * On success the message is mailed and NOTHING ELSE HAPPENS —
 * `user.emailVerified` stays false. Verification happens when the code
 * in that message is redeemed (`applyActionCode`), not when it is sent.
 * Modeling that gap faithfully is the whole point: agent code that
 * gates on `emailVerified` must see it stay false here, exactly as it
 * would in production.
 */
export async function sendEmailVerification(
  user: User,
  settings?: ActionCodeSettings,
): Promise<void> {
  const t = userInternal(user, 'sendEmailVerification').target;
  const target = t;
  if (settings) validateActionCodeSettings(settings, 'sendEmailVerification');
  if (!user.email) {
    throw makeAuthError(
      'auth/missing-email',
      'An email address must be provided.',
    );
  }
  emit(target, {
    operation: ActionCodeOperation.VERIFY_EMAIL,
    email: user.email,
  }, settings);
}

/**
 * `verifyBeforeUpdateEmail(user, newEmail, settings?)` — mirror of
 * `firebase/auth`.
 *
 * Mails a code to the NEW address and returns. The account's email does
 * NOT change yet — it changes when that code is redeemed, which is the
 * one guarantee separating this API from a bare `updateEmail`: the user
 * must prove they control the new address before it becomes theirs.
 */
export async function verifyBeforeUpdateEmail(
  user: User,
  newEmail: string,
  settings?: ActionCodeSettings,
): Promise<void> {
  const t = userInternal(user, 'verifyBeforeUpdateEmail').target;
  const target = t;
  if (settings) validateActionCodeSettings(settings, 'verifyBeforeUpdateEmail');
  assertEmailFormat(newEmail, 'verifyBeforeUpdateEmail');
  if (!user.email) {
    throw makeAuthError('auth/missing-email', 'An email address must be provided.');
  }
  emit(target, {
    operation: ActionCodeOperation.VERIFY_AND_CHANGE_EMAIL,
    email: user.email,
    newEmail,
    // The code is mailed TO the new address — that is what makes
    // redeeming it proof of control.
    deliverTo: newEmail,
  }, settings);
}

// ─── Redeeming ────────────────────────────────────────────────────────

/**
 * `applyActionCode(auth, code)` — mirror of `firebase/auth`. Redeems a
 * code and performs its state change.
 *
 * `auth/invalid-action-code` for a code the sandbox never issued —
 * ORACLE-BACKED (`auth-action-code-invalid` captured exactly this
 * against prod, for both a bogus code and the empty string).
 * `auth/expired-action-code` for a code staged as expired.
 *
 * Single-use: the code is burned on redemption, so a replay throws
 * `auth/invalid-action-code` — matching prod.
 */
export async function applyActionCode(auth: Auth, code: string): Promise<void> {
  const t = targetOf(auth);
  const target = t;
  const spec = redeem(target, code, 'applyActionCode');
  switch (spec.operation) {
    case ActionCodeOperation.VERIFY_EMAIL:
      target.backend.setEmailVerified(spec.email, true);
      return;
    case ActionCodeOperation.VERIFY_AND_CHANGE_EMAIL:
      if (!spec.newEmail) {
        throw makeAuthError('auth/invalid-action-code', 'applyActionCode: the action code carries no target address.');
      }
      target.backend.changeEmail(spec.email, spec.newEmail);
      return;
    case ActionCodeOperation.RECOVER_EMAIL:
      target.backend.setEmailVerified(spec.email, true);
      return;
    case ActionCodeOperation.PASSWORD_RESET:
      // Prod rejects this: a reset code carries no new password, so
      // applyActionCode has nothing to apply. `confirmPasswordReset` is
      // the API that redeems it.
      throw makeAuthError(
        'auth/invalid-action-code',
        'applyActionCode: a password-reset code must be redeemed with confirmPasswordReset(auth, code, newPassword).',
      );
    default:
      throw makeAuthError(
        'auth/invalid-action-code',
        `applyActionCode: unsupported operation ${spec.operation}.`,
      );
  }
}

/**
 * `checkActionCode(auth, code)` — mirror of `firebase/auth`. Inspects a
 * code WITHOUT redeeming it, so the subsequent `applyActionCode` /
 * `confirmPasswordReset` still finds it. Throws
 * `auth/invalid-action-code` / `auth/expired-action-code` for a code
 * that is not live.
 */
export async function checkActionCode(auth: Auth, code: string): Promise<ActionCodeInfo> {
  const t = targetOf(auth);
  const target = t;
  const spec = peek(target, code, 'checkActionCode');
  // For a change-email code, `email` is where the code was mailed (the
  // NEW address) and `previousEmail` is the account's current one —
  // matching upstream's ActionCodeInfo shape.
  const isChange = spec.operation === ActionCodeOperation.VERIFY_AND_CHANGE_EMAIL;
  return {
    operation: spec.operation,
    data: {
      email: isChange ? (spec.newEmail ?? null) : spec.email,
      previousEmail: isChange ? spec.email : null,
      multiFactorInfo: null,
    },
  };
}

/**
 * `verifyPasswordResetCode(auth, code)` — mirror of `firebase/auth`.
 * Checks a reset code and returns the account's email. Does NOT redeem
 * it — `confirmPasswordReset` does.
 */
export async function verifyPasswordResetCode(auth: Auth, code: string): Promise<string> {
  const t = targetOf(auth);
  const target = t;
  const spec = peek(target, code, 'verifyPasswordResetCode');
  if (spec.operation !== ActionCodeOperation.PASSWORD_RESET) {
    throw makeAuthError(
      'auth/invalid-action-code',
      'verifyPasswordResetCode: the action code is not a password-reset code.',
    );
  }
  return spec.email;
}

/**
 * `confirmPasswordReset(auth, code, newPassword)` — mirror of
 * `firebase/auth`. Redeems a reset code and sets the new password.
 *
 * Real behavior on the sandbox: afterwards
 * `signInWithEmailAndPassword(auth, email, newPassword)` succeeds and
 * the OLD password throws `auth/wrong-password`. The new password runs
 * the same strength check `createUserWithEmailAndPassword` does, so a
 * reset cannot install a password the create path would have rejected
 * (`auth/weak-password`).
 */
export async function confirmPasswordReset(
  auth: Auth,
  code: string,
  newPassword: string,
): Promise<void> {
  const t = targetOf(auth);
  const target = t;
  // Peek first: a weak-password rejection must NOT burn the code, or the
  // user's one reset link would be destroyed by a typo.
  const spec = peek(target, code, 'confirmPasswordReset');
  if (spec.operation !== ActionCodeOperation.PASSWORD_RESET) {
    throw makeAuthError(
      'auth/invalid-action-code',
      'confirmPasswordReset: the action code is not a password-reset code.',
    );
  }
  target.backend.setPasswordByEmail(spec.email, newPassword);
  target.backend.consumeActionCode(code);
}

// ─── Shared internals ─────────────────────────────────────────────────

/** Mint a code, build its link, and post the message to the outbox. */
function emit(
  target: SandboxTarget,
  spec: AuthActionCode & { deliverTo?: string },
  settings: ActionCodeSettings | undefined,
): void {
  const { deliverTo, ...code } = spec;
  const oob = target.backend.mintActionCode(code);
  const mode = OPERATION_TO_MODE[spec.operation] ?? 'signIn';
  const link = buildActionLink(mode, oob, settings?.url ?? null);
  target.backend.deliverMail({
    operation: spec.operation,
    // The recipient — normally the account's address, but for
    // verify-and-change it is the NEW address the code proves control of.
    email: deliverTo ?? spec.email,
    code: oob,
    link,
    ...(spec.newEmail ? { newEmail: spec.newEmail } : {}),
  });
}

/** Read a code without burning it; throw the live-ness errors. */
function peek(target: SandboxTarget, code: string, api: string): AuthActionCode {
  const spec = target.backend.peekActionCode(code);
  assertLive(spec, code, api);
  return spec;
}

/** Read a code AND burn it; throw the live-ness errors. Single-use. */
function redeem(target: SandboxTarget, code: string, api: string): AuthActionCode {
  const spec = target.backend.peekActionCode(code);
  assertLive(spec, code, api);
  target.backend.consumeActionCode(code);
  return spec;
}

function assertLive(
  spec: AuthActionCode | undefined,
  code: string,
  api: string,
): asserts spec is AuthActionCode {
  if (!spec) {
    throw makeAuthError(
      'auth/invalid-action-code',
      `${api}: the action code is invalid. This can happen if the code is malformed, expired, or has already been used.`,
    );
  }
  if (spec.expired) {
    throw makeAuthError(
      'auth/expired-action-code',
      `${api}: the action code has expired.`,
    );
  }
  void code;
}

function assertEmailFormat(email: string, api: string): void {
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw makeAuthError('auth/invalid-email', `${api}: the email address is badly formatted.`);
  }
}

/** The sandbox target behind an `Auth` handle. */
export function requireSandboxTarget(auth: Auth, api: string): SandboxTarget {
  void api;
  return targetOf(auth);
}

/** The sandbox target behind a `User`, recovered from the user alone —
 *  the whole reason {@link UserInternal.target} exists (these APIs are
 *  handed a `User` and no `Auth`). */
export function requireSandboxUser(user: User, api: string): SandboxTarget {
  return userInternal(user, api).target;
}

/** Recover the backend hook stamped on every `User`. */
export function userInternal(user: User, name: string): UserInternal {
  const internal = (user as { [USER_INTERNAL]?: UserInternal })[USER_INTERNAL];
  if (!internal) {
    throw makeAuthError(
      'auth/invalid-user-token',
      `${name}: unrecognized user — was it produced by a pyric/auth sign-in?`,
    );
  }
  return internal;
}
