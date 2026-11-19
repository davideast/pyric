import { FirebaseError } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';
import { withClientAuthProbeSession } from '../../src/auth-user-probe-session.ts';
import { retryAuthTooManyRequests } from '../../src/oracle-run-auth-session.ts';

const PROBE_PASSWORD = 'ProbePassword!123';

interface EmptyPasswordSubjectUser {
  readonly uid: string;
}

interface EmptyPasswordSubjectAuth {
  readonly currentUser: EmptyPasswordSubjectUser | null;
}

export interface EmptyPasswordSignInProbeContext {
  readonly auth: EmptyPasswordSubjectAuth;
  readonly firebaseErrorCtor: abstract new (...args: never[]) => Error;
  readonly unknownEmail: string;
  readonly existingEmail: string;
  readonly existingUid: string;
  readonly validPassword: string;
  signInWithEmailAndPassword(
    auth: EmptyPasswordSubjectAuth,
    email: string,
    password: string,
  ): Promise<{ user: EmptyPasswordSubjectUser }>;
  onAuthStateChanged(
    auth: EmptyPasswordSubjectAuth,
    observer: (user: EmptyPasswordSubjectUser | null) => void,
  ): () => void;
  onIdTokenChanged(
    auth: EmptyPasswordSubjectAuth,
    observer: (user: EmptyPasswordSubjectUser | null) => void,
  ): () => void;
  settleListeners(): Promise<void>;
}

interface EmptyPasswordRejectionShape {
  [key: string]: unknown;
  threw: boolean;
  errorName: string | null;
  isFirebaseError: boolean;
  code: string | null;
  message: string | null;
}

async function captureEmptyPasswordAttempt(
  attempt: () => Promise<unknown>,
  firebaseErrorCtor: abstract new (...args: never[]) => Error,
  emailsToScrub: readonly string[],
): Promise<EmptyPasswordRejectionShape> {
  try {
    await attempt();
    return {
      threw: false,
      errorName: null,
      isFirebaseError: false,
      code: null,
      message: null,
    };
  } catch (err) {
    const candidate = err as { name?: unknown; code?: unknown; message?: unknown };
    let errorName: string | null = null;
    if (typeof candidate?.name === 'string') {
      errorName = candidate.name;
    }
    let code: string | null = null;
    if (typeof candidate?.code === 'string') {
      code = candidate.code;
    }
    let message: string | null = null;
    if (typeof candidate?.message === 'string') {
      let scrubbed = candidate.message;
      for (const email of emailsToScrub) {
        scrubbed = scrubbed.replaceAll(email, '<email>');
      }
      message = scrubbed;
    }
    return {
      threw: true,
      errorName,
      isFirebaseError: err instanceof firebaseErrorCtor,
      code,
      message,
    };
  }
}

export async function observeEmptyPasswordSignInSemantics(
  ctx: EmptyPasswordSignInProbeContext,
): Promise<Record<string, unknown>> {
  const scrubEmails = [ctx.unknownEmail, ctx.existingEmail];
  const authStateEvents: Array<string | null> = [];
  const idTokenEvents: Array<string | null> = [];

  const unsubAuth = ctx.onAuthStateChanged(ctx.auth, (user) => {
    let uid: string | null = null;
    if (user !== null) {
      uid = user.uid;
    }
    authStateEvents.push(uid);
  });
  const unsubIdToken = ctx.onIdTokenChanged(ctx.auth, (user) => {
    let uid: string | null = null;
    if (user !== null) {
      uid = user.uid;
    }
    idTokenEvents.push(uid);
  });

  try {
    await ctx.settleListeners();
    const baselineAuthFires = authStateEvents.length;
    const baselineIdTokenFires = idTokenEvents.length;

    const unknownAttempt = await captureEmptyPasswordAttempt(
      () => ctx.signInWithEmailAndPassword(ctx.auth, ctx.unknownEmail, ''),
      ctx.firebaseErrorCtor,
      scrubEmails,
    );
    await ctx.settleListeners();
    const currentUserNullAfterUnknown = ctx.auth.currentUser === null;
    const authStateFiresAfterUnknown = authStateEvents.length - baselineAuthFires;
    const idTokenFiresAfterUnknown = idTokenEvents.length - baselineIdTokenFires;

    const beforeExistingAuthFires = authStateEvents.length;
    const beforeExistingIdTokenFires = idTokenEvents.length;
    const existingAttempt = await captureEmptyPasswordAttempt(
      () => ctx.signInWithEmailAndPassword(ctx.auth, ctx.existingEmail, ''),
      ctx.firebaseErrorCtor,
      scrubEmails,
    );
    await ctx.settleListeners();
    const currentUserNullAfterExisting = ctx.auth.currentUser === null;
    const authStateFiresAfterExisting = authStateEvents.length - beforeExistingAuthFires;
    const idTokenFiresAfterExisting = idTokenEvents.length - beforeExistingIdTokenFires;

    const signedIn = await retryAuthTooManyRequests('auth-empty-pw-valid-signin', () =>
      ctx.signInWithEmailAndPassword(ctx.auth, ctx.existingEmail, ctx.validPassword),
    );
    await ctx.settleListeners();
    const signedInUidMatches =
      signedIn.user.uid === ctx.existingUid && ctx.auth.currentUser?.uid === ctx.existingUid;

    const beforeSignedInEmptyAuthFires = authStateEvents.length;
    const beforeSignedInEmptyIdTokenFires = idTokenEvents.length;
    const whileSignedInEmptyAttempt = await captureEmptyPasswordAttempt(
      () => ctx.signInWithEmailAndPassword(ctx.auth, ctx.unknownEmail, ''),
      ctx.firebaseErrorCtor,
      scrubEmails,
    );
    await ctx.settleListeners();
    const remainsSignedInAsExistingUid = ctx.auth.currentUser?.uid === ctx.existingUid;
    const authStateFiresWhileSignedIn = authStateEvents.length - beforeSignedInEmptyAuthFires;
    const idTokenFiresWhileSignedIn = idTokenEvents.length - beforeSignedInEmptyIdTokenFires;

    return {
      unknownEmailEmptyPassword: {
        ...unknownAttempt,
        currentUserRemainsNull: currentUserNullAfterUnknown,
        authStateListenerFires: authStateFiresAfterUnknown,
        idTokenListenerFires: idTokenFiresAfterUnknown,
      },
      existingUserEmptyPassword: {
        ...existingAttempt,
        currentUserRemainsNull: currentUserNullAfterExisting,
        authStateListenerFires: authStateFiresAfterExisting,
        idTokenListenerFires: idTokenFiresAfterExisting,
      },
      unknownMatchesExisting: {
        sameCode: unknownAttempt.code === existingAttempt.code,
        sameMessage: unknownAttempt.message === existingAttempt.message,
      },
      whileSignedInEmptyPassword: {
        signedInUidMatches,
        ...whileSignedInEmptyAttempt,
        remainsSignedInAsExistingUid,
        authStateListenerFires: authStateFiresWhileSignedIn,
        idTokenListenerFires: idTokenFiresWhileSignedIn,
      },
    };
  } finally {
    unsubIdToken();
    unsubAuth();
  }
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'admin-auth'],
  matrixRow: 'auth#15a',
  rowIds: ['auth#15a'],
  description:
    'signInWithEmailAndPassword(auth, email, "") error code, message text, currentUser preservation, and auth/idToken listener silence across both unknown email addresses and existing email-password accounts.',
  async observe() {
    return withClientAuthProbeSession(
      async ({ auth, authSdk, createProbeUser, nextEmail, nextUid }) => {
        const existingUid = nextUid('empty-pw-existing');
        const existingEmail = nextEmail('empty-pw-existing');
        const unknownEmail = nextEmail('empty-pw-unknown');
        await createProbeUser({
          uid: existingUid,
          email: existingEmail,
          password: PROBE_PASSWORD,
        });

        return observeEmptyPasswordSignInSemantics({
          auth,
          firebaseErrorCtor: FirebaseError,
          unknownEmail,
          existingEmail,
          existingUid,
          validPassword: PROBE_PASSWORD,
          signInWithEmailAndPassword: (inst, email, password) =>
            authSdk.signInWithEmailAndPassword(inst as never, email, password),
          onAuthStateChanged: (inst, cb) => authSdk.onAuthStateChanged(inst as never, cb as never),
          onIdTokenChanged: (inst, cb) => authSdk.onIdTokenChanged(inst as never, cb as never),
          settleListeners: () =>
            new Promise<void>((resolve) => {
              setTimeout(resolve, 25);
            }),
        });
      },
    );
  },
};
