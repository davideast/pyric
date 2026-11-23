/**
 * Dependency-injected capture session runner for `auth-google-oauth` (#1814).
 *
 * Enforces:
 *   1. Pre-flight check that aborts before any write or deletion if either
 *      target email already exists without `{ pyricOracleGoogleOAuthTest: true }`.
 *   2. Startup sweep that deletes ONLY orphaned users carrying
 *      `{ pyricOracleGoogleOAuthTest: true }`.
 *   3. Strict signed-in email match verification before recording anything; on
 *      mismatch, cleans up ONLY users created in this run and aborts without
 *      touching the mismatched account.
 *   4. Verified `finally` cleanup (`deleteUser` + `getUser` confirming
 *      `auth/user-not-found`) for every user created in this run.
 *   5. Neutral recording of whatever production returned for both `@gmail.com`
 *      and non-`@gmail.com`, sanitized through `writeAuthGoogleOAuthObservation`.
 */
import { randomBytes } from 'node:crypto';
import { normalizeEmailAddress } from './cli-args.ts';
import {
  sanitizeAuthErrorCode,
  sanitizeProviderIdList,
  writeAuthGoogleOAuthObservation,
  type AuthGoogleOAuthBehavior,
  type AuthGoogleOAuthObservation,
  type SanitizedGoogleCollisionCaseBehavior,
} from './observation-writer.ts';

export const GOOGLE_OAUTH_TEST_MARKER_CLAIM = 'pyricOracleGoogleOAuthTest';

export type CollisionCaseKind = 'gmail' | 'non-gmail';

export interface AdminUserSnapshot {
  readonly uid: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly hasPasswordHash: boolean;
  readonly providerIds: readonly string[];
  readonly customClaims: Readonly<Record<string, unknown>> | null;
  readonly displayName?: string | null;
  readonly photoURL?: string | null;
}

interface AdminListUsersResult {
  readonly users: readonly AdminUserSnapshot[];
  readonly pageToken?: string;
}

export interface AdminAuthDriver {
  getUserByEmail(email: string): Promise<AdminUserSnapshot | null>;
  getUser(uid: string): Promise<AdminUserSnapshot | null>;
  listUsers(maxResults: number, pageToken?: string): Promise<AdminListUsersResult>;
  createUser(input: {
    email: string;
    password: string;
    emailVerified: boolean;
  }): Promise<AdminUserSnapshot>;
  setCustomUserClaims(uid: string, claims: Record<string, unknown>): Promise<void>;
  deleteUser(uid: string): Promise<void>;
}

type PasswordSignInAttemptResult =
  | {
      readonly ok: true;
      readonly uid: string;
      readonly emailVerified: boolean;
      readonly providerIds: readonly string[];
    }
  | {
      readonly ok: false;
      readonly errorCode: string;
    };

export interface PasswordAuthDriver {
  signInWithPassword(email: string, password: string): Promise<PasswordSignInAttemptResult>;
}

export type GooglePopupStepResult =
  | {
      readonly outcome: 'resolved';
      readonly observedEmail: string | null;
      readonly resolvedUid: string;
      readonly userEmailVerified: boolean;
      readonly userProviderIds: readonly string[];
      readonly tokenEmailVerifiedClaim: boolean;
      readonly tokenSignInProvider: string | null;
      readonly credentialFromResultPresent: boolean;
      readonly sensitiveValues?: readonly string[];
    }
  | {
      readonly outcome: 'rejected';
      readonly observedEmail: string | null;
      readonly errorCode: string;
      readonly credentialFromErrorPresent: boolean;
      readonly sensitiveValues?: readonly string[];
    };

export interface GooglePopupDriver {
  runGooglePopup(input: {
    readonly step: CollisionCaseKind;
    readonly expectedEmail: string;
  }): Promise<GooglePopupStepResult>;
}

function hasGoogleOAuthTestMarker(
  claims: Readonly<Record<string, unknown>> | null | undefined,
): boolean {
  if (!claims || typeof claims !== 'object') {
    return false;
  }
  return claims[GOOGLE_OAUTH_TEST_MARKER_CLAIM] === true;
}

async function sweepMarkedOrphanUsers(
  adminAuth: AdminAuthDriver,
  log: (message: string) => void = () => {},
): Promise<number> {
  const markedUids: string[] = [];
  let pageToken: string | undefined;

  for (;;) {
    const page = await adminAuth.listUsers(1000, pageToken);
    for (const user of page.users) {
      if (hasGoogleOAuthTestMarker(user.customClaims)) {
        markedUids.push(user.uid);
      }
    }
    if (!page.pageToken) {
      break;
    }
    pageToken = page.pageToken;
  }

  for (const uid of markedUids) {
    await adminAuth.deleteUser(uid);
    const remaining = await adminAuth.getUser(uid);
    if (remaining !== null) {
      throw new Error(
        `Startup sweep deletion verification failed: marked orphan user still exists after deleteUser.`,
      );
    }
  }

  if (markedUids.length > 0) {
    log(`[auth-google-oauth] startup sweep removed ${markedUids.length} marked orphan user(s).`);
  }
  return markedUids.length;
}

async function assertPreFlightEmailsSafe(
  adminAuth: AdminAuthDriver,
  gmailEmail: string,
  nonGmailEmail: string,
): Promise<void> {
  const targets: ReadonlyArray<{ label: CollisionCaseKind; email: string }> = [
    { label: 'gmail', email: gmailEmail },
    { label: 'non-gmail', email: nonGmailEmail },
  ];

  for (const target of targets) {
    const existing = await adminAuth.getUserByEmail(target.email);
    if (existing !== null && !hasGoogleOAuthTestMarker(existing.customClaims)) {
      throw new Error(
        `Pre-flight aborted: the ${target.label} account already exists in the project without custom claim '${GOOGLE_OAUTH_TEST_MARKER_CLAIM}: true'. Refusing to modify or delete unmarked accounts.`,
      );
    }
  }
}

async function assertTargetEmailsAbsentAfterSweep(
  adminAuth: AdminAuthDriver,
  gmailEmail: string,
  nonGmailEmail: string,
): Promise<void> {
  for (const [label, email] of [
    ['gmail', gmailEmail],
    ['non-gmail', nonGmailEmail],
  ] as const) {
    const stillPresent = await adminAuth.getUserByEmail(email);
    if (stillPresent !== null) {
      throw new Error(
        `Pre-flight aborted: ${label} account still exists after startup sweep; refusing to touch pre-existing state.`,
      );
    }
  }
}

export interface RunGoogleOAuthCollisionCaptureOptions {
  readonly gmailEmail: string;
  readonly nonGmailEmail: string;
  readonly obsDir: string;
  readonly fbSdkVersion: string;
  readonly adminSdkVersion: string;
  readonly projectAllowDuplicateEmails: boolean | null;
  readonly adminAuth: AdminAuthDriver;
  readonly passwordDriver: PasswordAuthDriver;
  readonly popupDriver: GooglePopupDriver;
  readonly extraSensitiveValues?: readonly string[];
  readonly log?: (message: string) => void;
}

export interface RunGoogleOAuthCollisionCaptureResult {
  readonly sweptOrphanCount: number;
  readonly filePath: string;
  readonly observation: AuthGoogleOAuthObservation;
}

function recordSensitiveUserFields(target: Set<string>, user: AdminUserSnapshot | null): void {
  if (!user) {
    return;
  }
  target.add(user.uid);
  if (user.email) {
    target.add(user.email);
  }
  if (user.displayName) {
    target.add(user.displayName);
  }
  if (user.photoURL) {
    target.add(user.photoURL);
  }
}

export async function runGoogleOAuthCollisionCapture(
  options: RunGoogleOAuthCollisionCaptureOptions,
): Promise<RunGoogleOAuthCollisionCaptureResult> {
  const gmailEmail = normalizeEmailAddress(options.gmailEmail);
  const nonGmailEmail = normalizeEmailAddress(options.nonGmailEmail);
  const log = options.log ?? ((msg: string) => console.log(msg));

  const sensitiveValues = new Set<string>([gmailEmail, nonGmailEmail]);
  if (options.extraSensitiveValues !== undefined) {
    for (const item of options.extraSensitiveValues) {
      sensitiveValues.add(item);
    }
  }

  await assertPreFlightEmailsSafe(options.adminAuth, gmailEmail, nonGmailEmail);
  const sweptOrphanCount = await sweepMarkedOrphanUsers(options.adminAuth, log);
  await assertTargetEmailsAbsentAfterSweep(options.adminAuth, gmailEmail, nonGmailEmail);

  const pendingCleanupUids = new Set<string>();

  async function cleanupAndVerifyCreatedUsers(): Promise<void> {
    const uids = [...pendingCleanupUids];
    const failures: string[] = [];

    for (const uid of uids) {
      try {
        await options.adminAuth.deleteUser(uid);
        const verifyGone = await options.adminAuth.getUser(uid);
        if (verifyGone !== null) {
          failures.push('created test user still readable after deleteUser');
        } else {
          pendingCleanupUids.delete(uid);
        }
      } catch (err: unknown) {
        const code = sanitizeAuthErrorCode(err);
        if (code === 'auth/user-not-found') {
          const verifyGone = await options.adminAuth.getUser(uid);
          if (verifyGone === null) {
            pendingCleanupUids.delete(uid);
            continue;
          }
        }
        let detail = String(err);
        if (err instanceof Error) {
          detail = err.message;
        }
        failures.push(detail);
      }
    }

    if (failures.length > 0) {
      throw new Error(`Cleanup verification failed: ${failures.join('; ')}`);
    }
  }

  async function runSingleCollisionCase(
    step: CollisionCaseKind,
    expectedEmail: string,
  ): Promise<SanitizedGoogleCollisionCaseBehavior> {
    const randomPassword = `OraclePw!${randomBytes(16).toString('hex')}`;
    sensitiveValues.add(randomPassword);

    const seeded = await options.adminAuth.createUser({
      email: expectedEmail,
      password: randomPassword,
      emailVerified: false,
    });
    pendingCleanupUids.add(seeded.uid);
    recordSensitiveUserFields(sensitiveValues, seeded);

    await options.adminAuth.setCustomUserClaims(seeded.uid, {
      [GOOGLE_OAUTH_TEST_MARKER_CLAIM]: true,
    });

    const baselineSignIn = await options.passwordDriver.signInWithPassword(
      expectedEmail,
      randomPassword,
    );
    let seededBaselinePasswordSignInSucceeded = false;
    let seededBaselineEmailVerified = false;
    let seededBaselineProviderIds: string[] = [];
    if (baselineSignIn.ok) {
      sensitiveValues.add(baselineSignIn.uid);
      seededBaselinePasswordSignInSucceeded = true;
      seededBaselineEmailVerified = baselineSignIn.emailVerified;
      seededBaselineProviderIds = sanitizeProviderIdList(baselineSignIn.providerIds);
    }

    log(`[auth-google-oauth] awaiting interactive Google popup for ${step} account...`);
    const popup = await options.popupDriver.runGooglePopup({ step, expectedEmail });
    for (const item of popup.sensitiveValues ?? []) {
      sensitiveValues.add(item);
    }
    if (popup.observedEmail) {
      sensitiveValues.add(popup.observedEmail);
    }
    if (popup.outcome === 'resolved') {
      sensitiveValues.add(popup.resolvedUid);
    }

    if (!popup.observedEmail) {
      let codeNote = 'none';
      if (popup.outcome === 'rejected') {
        codeNote = sanitizeAuthErrorCode({ code: popup.errorCode });
      }
      throw new Error(
        `Google popup for ${step} did not yield a signed-in account email (code=${codeNote}); aborting without recording.`,
      );
    }

    const actualNormalizedEmail = normalizeEmailAddress(popup.observedEmail);
    if (actualNormalizedEmail !== expectedEmail) {
      throw new Error(
        `Account email mismatch on ${step} popup: signed-in Google account did not match the expected --${step} address. Cleaning up only users created in this run and aborting.`,
      );
    }

    if (popup.outcome === 'resolved' && popup.resolvedUid !== seeded.uid) {
      pendingCleanupUids.add(popup.resolvedUid);
      await options.adminAuth.setCustomUserClaims(popup.resolvedUid, {
        [GOOGLE_OAUTH_TEST_MARKER_CLAIM]: true,
      });
    }

    const postAdminRecord = await options.adminAuth.getUser(seeded.uid);
    recordSensitiveUserFields(sensitiveValues, postAdminRecord);

    let seededRecordStillExists = false;
    let postAttemptAdminEmailVerified: boolean | null = null;
    let postAttemptAdminHasPasswordHash: boolean | null = null;
    let postAttemptAdminProviderIds: readonly string[] | null = null;
    if (postAdminRecord !== null) {
      seededRecordStillExists = true;
      postAttemptAdminEmailVerified = postAdminRecord.emailVerified;
      postAttemptAdminHasPasswordHash = postAdminRecord.hasPasswordHash;
      postAttemptAdminProviderIds = sanitizeProviderIdList(postAdminRecord.providerIds);
    }

    const postPassword = await options.passwordDriver.signInWithPassword(
      expectedEmail,
      randomPassword,
    );
    let postAttemptPasswordSignInSucceeded = false;
    let postAttemptPasswordErrorCode: string | null = null;
    if (postPassword.ok) {
      sensitiveValues.add(postPassword.uid);
      postAttemptPasswordSignInSucceeded = true;
    } else {
      postAttemptPasswordErrorCode = sanitizeAuthErrorCode({ code: postPassword.errorCode });
    }

    let popupSucceeded = false;
    let popupErrorCode: string | null = null;
    let credentialFromResultPresent = false;
    let credentialFromErrorPresent = false;
    let resolvedSameUidAsSeeded: boolean | null = null;
    let resolvedUserEmailVerified: boolean | null = null;
    let resolvedUserProviderIds: readonly string[] | null = null;
    let resolvedTokenEmailVerifiedClaim: boolean | null = null;
    let resolvedTokenSignInProvider: string | null = null;

    if (popup.outcome === 'resolved') {
      popupSucceeded = true;
      credentialFromResultPresent = popup.credentialFromResultPresent;
      resolvedSameUidAsSeeded = popup.resolvedUid === seeded.uid;
      resolvedUserEmailVerified = popup.userEmailVerified;
      resolvedUserProviderIds = sanitizeProviderIdList(popup.userProviderIds);
      resolvedTokenEmailVerifiedClaim = popup.tokenEmailVerifiedClaim;
      if (popup.tokenSignInProvider !== null) {
        const cleanedSignInProvider = sanitizeProviderIdList([popup.tokenSignInProvider]);
        resolvedTokenSignInProvider = cleanedSignInProvider[0] ?? null;
      }
    } else {
      popupErrorCode = sanitizeAuthErrorCode({ code: popup.errorCode });
      credentialFromErrorPresent = popup.credentialFromErrorPresent;
    }

    await cleanupAndVerifyCreatedUsers();

    return {
      seededBaselinePasswordSignInSucceeded,
      seededBaselineEmailVerified,
      seededBaselineProviderIds,
      popupSucceeded,
      popupErrorCode,
      credentialFromResultPresent,
      credentialFromErrorPresent,
      resolvedSameUidAsSeeded,
      resolvedUserEmailVerified,
      resolvedUserProviderIds,
      resolvedTokenEmailVerifiedClaim,
      resolvedTokenSignInProvider,
      seededRecordStillExists,
      postAttemptAdminEmailVerified,
      postAttemptAdminHasPasswordHash,
      postAttemptAdminProviderIds,
      postAttemptPasswordSignInSucceeded,
      postAttemptPasswordErrorCode,
    };
  }

  let primaryError: unknown = null;
  let written: { filePath: string; observation: AuthGoogleOAuthObservation } | null = null;

  try {
    const gmailUnverifiedAccountCollision = await runSingleCollisionCase('gmail', gmailEmail);
    const nonGmailUnverifiedAccountCollision = await runSingleCollisionCase(
      'non-gmail',
      nonGmailEmail,
    );

    await cleanupAndVerifyCreatedUsers();

    const behavior: AuthGoogleOAuthBehavior = {
      projectAllowDuplicateEmails: options.projectAllowDuplicateEmails,
      gmailUnverifiedAccountCollision,
      nonGmailUnverifiedAccountCollision,
    };

    written = writeAuthGoogleOAuthObservation({
      obsDir: options.obsDir,
      fbSdkVersion: options.fbSdkVersion,
      adminSdkVersion: options.adminSdkVersion,
      behavior,
      sensitiveRuntimeValues: [...sensitiveValues],
    });
  } catch (err: unknown) {
    primaryError = err;
  } finally {
    if (pendingCleanupUids.size > 0) {
      try {
        await cleanupAndVerifyCreatedUsers();
      } catch (cleanupErr: unknown) {
        if (primaryError === null) {
          primaryError = cleanupErr;
        }
      }
    }
  }

  if (primaryError !== null) {
    throw primaryError;
  }
  if (written === null) {
    throw new Error('Capture session ended without producing an observation.');
  }

  log(`[auth-google-oauth] verified cleanup complete; wrote ${written.filePath}`);
  return {
    sweptOrphanCount,
    filePath: written.filePath,
    observation: written.observation,
  };
}
