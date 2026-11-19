import type { Behavior, Pin } from './capture/sdk-scenarios/replay-comparison.ts';

interface ReplayRecentLoginTokenResult {
  readonly authTime: string;
  readonly issuedAtTime: string;
}

interface ReplayRecentLoginUser {
  readonly uid: string;
  readonly email: string | null;
  getIdToken(forceRefresh?: boolean): Promise<string>;
  getIdTokenResult(forceRefresh?: boolean): Promise<ReplayRecentLoginTokenResult>;
}

interface ReplayRecentLoginAuthHandle {
  readonly currentUser: ReplayRecentLoginUser | null;
}

export interface ReplayRecentLoginAuthSdk {
  createEmailCredential(email: string, password: string): unknown;
  createUserWithEmailAndPassword(
    auth: ReplayRecentLoginAuthHandle,
    email: string,
    password: string,
  ): Promise<{ user: ReplayRecentLoginUser }>;
  signInWithEmailAndPassword(
    auth: ReplayRecentLoginAuthHandle,
    email: string,
    password: string,
  ): Promise<{ user: ReplayRecentLoginUser }>;
  signInAnonymously(auth: ReplayRecentLoginAuthHandle): Promise<{ user: ReplayRecentLoginUser }>;
  signOut(auth: ReplayRecentLoginAuthHandle): Promise<void>;
  updateProfile(
    user: ReplayRecentLoginUser,
    profile: { displayName?: string | null },
  ): Promise<void>;
  updateEmail(user: ReplayRecentLoginUser, newEmail: string): Promise<void>;
  updatePassword(user: ReplayRecentLoginUser, newPassword: string): Promise<void>;
  verifyBeforeUpdateEmail(user: ReplayRecentLoginUser, newEmail: string): Promise<void>;
  deleteUser(user: ReplayRecentLoginUser): Promise<void>;
  linkWithCredential(
    user: ReplayRecentLoginUser,
    credential: unknown,
  ): Promise<{ user: ReplayRecentLoginUser }>;
  unlink(user: ReplayRecentLoginUser, providerId: string): Promise<ReplayRecentLoginUser>;
  reauthenticateWithCredential(
    user: ReplayRecentLoginUser,
    credential: unknown,
  ): Promise<{ user: ReplayRecentLoginUser }>;
}

export interface AuthUpdateEmailRecentLoginSession {
  readonly auth: ReplayRecentLoginAuthHandle;
  readonly authSdk: ReplayRecentLoginAuthSdk;
  advanceClock(ms: number): Promise<void>;
  cleanup(): Promise<void>;
}

export interface AuthUpdateEmailRecentLoginFactory {
  openSession(label: string): Promise<AuthUpdateEmailRecentLoginSession>;
  nextEmail(label: string): string;
}

interface GatedOutcome {
  code: string | null;
  message?: string;
}

const PASSWORD = 'ProbePassword!123';

async function recordOutcome(attempt: () => Promise<unknown>): Promise<GatedOutcome> {
  try {
    await attempt();
    return { code: null };
  } catch (err) {
    const candidate = err as { code?: unknown; message?: unknown };
    let code = 'unknown';
    if (typeof candidate?.code === 'string') {
      code = candidate.code;
    }
    let message = '';
    if (typeof candidate?.message === 'string') {
      message = candidate.message;
    }
    return { code, message };
  }
}

export function buildAuthUpdateEmailDivergencePin(production: Behavior): Pin {
  const prodGated = production.gated as Record<string, unknown>;
  return {
    key: 'gated',
    finding:
      'auth#84: production refuses direct updateEmail with auth/operation-not-allowed under Email Enumeration Protection; Pyric mutates email inside the recent-login window and enforces auth/requires-recent-login on stale sessions',
    production: prodGated,
    pyric: {
      ...prodGated,
      updateEmail: {
        code: 'auth/requires-recent-login',
        message: 'Firebase: Error (auth/requires-recent-login).',
      },
    },
  };
}

export async function replayAuthRequiresRecentLoginAndUpdateEmail(
  factory: AuthUpdateEmailRecentLoginFactory,
  production: Behavior,
): Promise<{
  pyric: Behavior;
  updateEmailLifecycle: {
    freshChangedEmailInPlace: boolean;
    oldEmailSignInCode: string | null;
    newEmailSignedInSameUid: boolean;
    invalidEmailCode: string | null;
    duplicateEmailCode: string | null;
    stalePreservedPreviousEmail: boolean;
    afterReauthUpdateEmailCode: string | null;
    afterReauthEmailUpdated: boolean;
  };
}> {
  const cleanups: Array<() => Promise<void>> = [];
  const openTracked = async (label: string): Promise<AuthUpdateEmailRecentLoginSession> => {
    const session = await factory.openSession(label);
    cleanups.push(() => session.cleanup());
    return session;
  };

  try {
    const freshSession = await openTracked('fresh');
    const freshEmail = factory.nextEmail('fresh');
    const freshCreated = await freshSession.authSdk.createUserWithEmailAndPassword(
      freshSession.auth,
      freshEmail,
      PASSWORD,
    );
    const freshUpdatePassword = await recordOutcome(() =>
      freshSession.authSdk.updatePassword(freshCreated.user, `${PASSWORD}-fresh`),
    );

    const rawBrackets = production.windowBracket as Array<{
      targetAgeSeconds: number;
      ageSeconds: number;
    }>;
    const windowBracket: Array<{
      targetAgeSeconds: number;
      ageSeconds: number;
      deleteUser: string | null;
    }> = [];
    for (const entry of rawBrackets) {
      const bracketSession = await openTracked(`bracket-${entry.targetAgeSeconds}`);
      const bracketEmail = factory.nextEmail(`bracket-${entry.targetAgeSeconds}`);
      const created = await bracketSession.authSdk.createUserWithEmailAndPassword(
        bracketSession.auth,
        bracketEmail,
        PASSWORD,
      );
      await bracketSession.advanceClock(entry.ageSeconds * 1000);
      const delOutcome = await recordOutcome(() =>
        bracketSession.authSdk.deleteUser(created.user),
      );
      windowBracket.push({
        targetAgeSeconds: entry.targetAgeSeconds,
        ageSeconds: entry.ageSeconds,
        deleteUser: delOutcome.code,
      });
    }

    const rawGated = production.gated as { ageSeconds: number };
    const gatedAgeSeconds = rawGated.ageSeconds;

    const refreshSession = await openTracked('forced-refresh');
    const refreshEmail = factory.nextEmail('forced-refresh');
    const refreshCreated = await refreshSession.authSdk.createUserWithEmailAndPassword(
      refreshSession.auth,
      refreshEmail,
      PASSWORD,
    );
    await refreshSession.advanceClock(120 * 1000);
    const refreshedToken = await refreshCreated.user.getIdTokenResult(true);
    const forcedRefresh = {
      issuedAtChanged: refreshedToken.issuedAtTime !== refreshedToken.authTime,
      authTimeOlderThanIssuedAt:
        Date.parse(refreshedToken.authTime) < Date.parse(refreshedToken.issuedAtTime),
    };
    await refreshSession.advanceClock((gatedAgeSeconds - 120) * 1000);
    const afterForcedRefreshUpdatePassword = await recordOutcome(() =>
      refreshSession.authSdk.updatePassword(refreshCreated.user, `${PASSWORD}-after-refresh`),
    );

    const staleSession = await openTracked('stale-gated');
    const staleEmail = factory.nextEmail('stale-gated');
    const staleMovedEmail = factory.nextEmail('stale-moved');
    const staleCreated = await staleSession.authSdk.createUserWithEmailAndPassword(
      staleSession.auth,
      staleEmail,
      PASSWORD,
    );
    await staleSession.advanceClock(gatedAgeSeconds * 1000);

    const gatedUpdateProfile = await recordOutcome(() =>
      staleSession.authSdk.updateProfile(staleCreated.user, { displayName: 'stale-profile' }),
    );
    const gatedGetIdTokenForced = await recordOutcome(() => staleCreated.user.getIdToken(true));
    const gatedUpdatePassword = await recordOutcome(() =>
      staleSession.authSdk.updatePassword(staleCreated.user, `${PASSWORD}-stale`),
    );
    const gatedUpdateEmail = await recordOutcome(() =>
      staleSession.authSdk.updateEmail(staleCreated.user, staleMovedEmail),
    );
    const stalePreservedPreviousEmail = staleCreated.user.email === staleEmail;
    const gatedVerifyBeforeUpdateEmail = await recordOutcome(() =>
      staleSession.authSdk.verifyBeforeUpdateEmail(staleCreated.user, staleMovedEmail),
    );
    const gatedDeleteUser = await recordOutcome(() =>
      staleSession.authSdk.deleteUser(staleCreated.user),
    );

    const unlinkSession = await openTracked('stale-unlink');
    const unlinkEmail = factory.nextEmail('stale-unlink');
    const unlinkCreated = await unlinkSession.authSdk.createUserWithEmailAndPassword(
      unlinkSession.auth,
      unlinkEmail,
      PASSWORD,
    );
    await unlinkSession.advanceClock(gatedAgeSeconds * 1000);
    const gatedUnlinkPassword = await recordOutcome(() =>
      unlinkSession.authSdk.unlink(unlinkCreated.user, 'password'),
    );

    const anonLinkSession = await openTracked('anon-link');
    const anonLinkCreated = await anonLinkSession.authSdk.signInAnonymously(anonLinkSession.auth);
    await anonLinkSession.advanceClock(gatedAgeSeconds * 1000);
    const anonLinkCred = anonLinkSession.authSdk.createEmailCredential(
      factory.nextEmail('anon-link'),
      PASSWORD,
    );
    const gatedAnonLink = await recordOutcome(() =>
      anonLinkSession.authSdk.linkWithCredential(anonLinkCreated.user, anonLinkCred),
    );

    const anonDeleteSession = await openTracked('anon-delete');
    const anonDeleteCreated = await anonDeleteSession.authSdk.signInAnonymously(
      anonDeleteSession.auth,
    );
    await anonDeleteSession.advanceClock(gatedAgeSeconds * 1000);
    const gatedAnonDelete = await recordOutcome(() =>
      anonDeleteSession.authSdk.deleteUser(anonDeleteCreated.user),
    );

    const reauthCred = staleSession.authSdk.createEmailCredential(staleEmail, PASSWORD);
    const reauthenticateOutcome = await recordOutcome(() =>
      staleSession.authSdk.reauthenticateWithCredential(staleCreated.user, reauthCred),
    );
    const afterReauthUpdateEmailTarget = factory.nextEmail('after-reauth-email');
    const afterReauthUpdateEmailOutcome = await recordOutcome(() =>
      staleSession.authSdk.updateEmail(staleCreated.user, afterReauthUpdateEmailTarget),
    );
    const afterReauthEmailUpdated = staleCreated.user.email === afterReauthUpdateEmailTarget;
    const afterReauthUpdatePassword = await recordOutcome(() =>
      staleSession.authSdk.updatePassword(staleCreated.user, `${PASSWORD}-after-reauth`),
    );
    const afterReauthDeleteUser = await recordOutcome(() =>
      staleSession.authSdk.deleteUser(staleCreated.user),
    );

    const emailMutationSession = await openTracked('email-mutation');
    const takenEmail = factory.nextEmail('email-taken');
    await emailMutationSession.authSdk.createUserWithEmailAndPassword(
      emailMutationSession.auth,
      takenEmail,
      PASSWORD,
    );
    await emailMutationSession.authSdk.signOut(emailMutationSession.auth);

    const initialEmail = factory.nextEmail('email-initial');
    const updatedEmail = factory.nextEmail('email-updated');
    const ownerCreated = await emailMutationSession.authSdk.createUserWithEmailAndPassword(
      emailMutationSession.auth,
      initialEmail,
      PASSWORD,
    );
    const ownerUid = ownerCreated.user.uid;

    const invalidEmailOutcome = await recordOutcome(() =>
      emailMutationSession.authSdk.updateEmail(ownerCreated.user, 'not-an-email'),
    );
    const duplicateEmailOutcome = await recordOutcome(() =>
      emailMutationSession.authSdk.updateEmail(ownerCreated.user, takenEmail),
    );
    await emailMutationSession.authSdk.updateEmail(ownerCreated.user, updatedEmail);
    const freshChangedEmailInPlace = ownerCreated.user.email === updatedEmail;

    await emailMutationSession.authSdk.signOut(emailMutationSession.auth);
    const oldEmailSignInOutcome = await recordOutcome(() =>
      emailMutationSession.authSdk.signInWithEmailAndPassword(
        emailMutationSession.auth,
        initialEmail,
        PASSWORD,
      ),
    );
    const newEmailSignedIn = await emailMutationSession.authSdk.signInWithEmailAndPassword(
      emailMutationSession.auth,
      updatedEmail,
      PASSWORD,
    );
    const newEmailSignedInSameUid =
      newEmailSignedIn.user.uid === ownerUid && newEmailSignedIn.user.email === updatedEmail;

    return {
      pyric: {
        freshUpdatePassword,
        windowBracket,
        forcedRefresh,
        gated: {
          ageSeconds: gatedAgeSeconds,
          updateProfile: gatedUpdateProfile,
          getIdTokenForced: gatedGetIdTokenForced,
          updatePassword: gatedUpdatePassword,
          updateEmail: gatedUpdateEmail,
          verifyBeforeUpdateEmail: gatedVerifyBeforeUpdateEmail,
          deleteUser: gatedDeleteUser,
          unlinkPassword: gatedUnlinkPassword,
          anonymousLinkWithCredential: gatedAnonLink,
          anonymousDeleteUser: gatedAnonDelete,
          afterForcedRefreshUpdatePassword,
        },
        afterReauth: {
          reauthenticate: reauthenticateOutcome,
          updatePassword: afterReauthUpdatePassword,
          deleteUser: afterReauthDeleteUser,
        },
        cleanupLeaked: false,
      },
      updateEmailLifecycle: {
        freshChangedEmailInPlace,
        oldEmailSignInCode: oldEmailSignInOutcome.code,
        newEmailSignedInSameUid,
        invalidEmailCode: invalidEmailOutcome.code,
        duplicateEmailCode: duplicateEmailOutcome.code,
        stalePreservedPreviousEmail,
        afterReauthUpdateEmailCode: afterReauthUpdateEmailOutcome.code,
        afterReauthEmailUpdated,
      },
    };
  } finally {
    for (const fn of cleanups.reverse()) {
      await fn();
    }
  }
}
