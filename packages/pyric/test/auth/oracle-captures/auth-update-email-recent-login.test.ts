import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { deleteApp, type FirebaseApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import {
  createUserWithEmailAndPassword,
  deleteUser,
  EmailAuthProvider,
  getAuth,
  linkWithCredential,
  reauthenticateWithCredential,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut,
  unlink,
  updateEmail,
  updatePassword,
  updateProfile,
  verifyBeforeUpdateEmail,
} from 'pyric/auth';
import { getClock, initializeSandbox } from 'pyric/sandbox';
import {
  buildAuthUpdateEmailDivergencePin,
  replayAuthRequiresRecentLoginAndUpdateEmail,
  type AuthUpdateEmailRecentLoginFactory,
  type AuthUpdateEmailRecentLoginSession,
  type ReplayRecentLoginAuthSdk,
} from '../../../../conformance/src/auth-update-email-recent-login-replay.ts';
import {
  replayMismatches,
  type Behavior,
  type Replay,
} from '../../../../conformance/src/capture/sdk-scenarios/replay-comparison.ts';

function load(stem: string): Behavior {
  return (
    JSON.parse(
      readFileSync(
        new URL(`../../../../conformance/observations/auth/${stem}.json`, import.meta.url),
        'utf8',
      ),
    ) as { behavior: Behavior }
  ).behavior;
}

function expectReplay(replay: Replay): void {
  expect(replayMismatches(replay)).toEqual([]);
}

let appSeq = 0;

function inPageUpdateEmailFactory(): AuthUpdateEmailRecentLoginFactory {
  let emailSeq = 0;
  return {
    nextEmail(label: string): string {
      emailSeq += 1;
      return `inpage-ue-${label}-${emailSeq}@example.com`;
    },
    async openSession(label: string): Promise<AuthUpdateEmailRecentLoginSession> {
      const sandbox = initializeSandbox();
      appSeq += 1;
      const app: FirebaseApp = createAppForSandbox(
        sandbox,
        { projectId: 'demo-auth-update-email', apiKey: 'demo-inpage-ue-key' },
        `inpage-ue-${label}-${appSeq}`,
      );
      const auth = getAuth(app);
      const authSdk: ReplayRecentLoginAuthSdk = {
        createEmailCredential: (email, password) => EmailAuthProvider.credential(email, password),
        createUserWithEmailAndPassword: (inst, email, password) =>
          createUserWithEmailAndPassword(inst as never, email, password) as never,
        signInWithEmailAndPassword: (inst, email, password) =>
          signInWithEmailAndPassword(inst as never, email, password) as never,
        signInAnonymously: (inst) => signInAnonymously(inst as never) as never,
        signOut: (inst) => signOut(inst as never),
        updateProfile: (user, profile) => updateProfile(user as never, profile),
        updateEmail: (user, newEmail) => updateEmail(user as never, newEmail),
        updatePassword: (user, newPassword) => updatePassword(user as never, newPassword),
        verifyBeforeUpdateEmail: (user, newEmail) =>
          verifyBeforeUpdateEmail(user as never, newEmail),
        deleteUser: (user) => deleteUser(user as never),
        linkWithCredential: (user, credential) =>
          linkWithCredential(user as never, credential as never) as never,
        unlink: (user, providerId) => unlink(user as never, providerId) as never,
        reauthenticateWithCredential: (user, credential) =>
          reauthenticateWithCredential(user as never, credential as never) as never,
      };
      return {
        auth: auth as never,
        authSdk,
        advanceClock: async (ms: number) => {
          getClock(sandbox).advance(ms);
        },
        cleanup: async () => {
          try {
            await deleteApp(app);
          } catch {
            // Best-effort app disposal.
          }
          sandbox.dispose();
        },
      };
    },
  };
}

describe('Auth updateEmail and requires-recent-login oracle capture (in-page pyric/auth)', () => {
  it('auth-requires-recent-login gated.updateEmail divergence and email lifecycle (auth#84)', async () => {
    const production = load('auth-requires-recent-login');
    const { pyric, updateEmailLifecycle } = await replayAuthRequiresRecentLoginAndUpdateEmail(
      inPageUpdateEmailFactory(),
      production,
    );
    expectReplay({
      production,
      pyric,
      pins: [buildAuthUpdateEmailDivergencePin(production)],
    });
    expect(updateEmailLifecycle).toEqual({
      freshChangedEmailInPlace: true,
      oldEmailSignInCode: 'auth/invalid-credential',
      newEmailSignedInSameUid: true,
      invalidEmailCode: 'auth/invalid-email',
      duplicateEmailCode: 'auth/email-already-in-use',
      stalePreservedPreviousEmail: true,
      afterReauthUpdateEmailCode: null,
      afterReauthEmailUpdated: true,
    });
  });
});
