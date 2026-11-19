import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { deleteApp, FirebaseError, type FirebaseApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import {
  getAuth,
  onAuthStateChanged,
  onIdTokenChanged,
  sandbox as authSandbox,
  signInWithEmailAndPassword,
} from 'pyric/auth';
import { initializeSandbox } from 'pyric/sandbox';
import {
  replayAuthSignInEmptyPasswordError,
  type AuthEmptyPasswordReplaySession,
} from '../../../../conformance/src/auth-signin-empty-password-replay.ts';
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

function inPageEmptyPasswordSession(): AuthEmptyPasswordReplaySession {
  const sandbox = initializeSandbox();
  appSeq += 1;
  const app: FirebaseApp = createAppForSandbox(
    sandbox,
    { projectId: 'demo-auth-empty-password', apiKey: 'demo-inpage-ep-key' },
    `inpage-ep-${appSeq}`,
  );
  const auth = getAuth(app);
  const existingUid = `inpage-ep-uid-${appSeq}`;
  const existingEmail = `inpage-ep-existing-${appSeq}@example.com`;
  const unknownEmail = `inpage-ep-unknown-${appSeq}@example.com`;
  const validPassword = 'ProbePassword!123';

  authSandbox.seedUsers(auth, [
    { uid: existingUid, email: existingEmail, password: validPassword },
  ]);

  return {
    context: {
      auth,
      firebaseErrorCtor: FirebaseError,
      unknownEmail,
      existingEmail,
      existingUid,
      validPassword,
      signInWithEmailAndPassword: (inst, email, password) =>
        signInWithEmailAndPassword(inst as never, email, password),
      onAuthStateChanged: (inst, cb) => onAuthStateChanged(inst as never, cb as never),
      onIdTokenChanged: (inst, cb) => onIdTokenChanged(inst as never, cb as never),
      settleListeners: async () => {
        for (let i = 0; i < 4; i += 1) {
          await Promise.resolve();
        }
      },
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
}

describe('Auth signInWithEmailAndPassword empty-password oracle capture (in-page pyric/auth)', () => {
  it('auth-signin-empty-password-error (auth#15a)', async () => {
    const production = load('auth-signin-empty-password-error');
    const pyric = await replayAuthSignInEmptyPasswordError(inPageEmptyPasswordSession());
    expectReplay({ production, pyric });
  });
});
