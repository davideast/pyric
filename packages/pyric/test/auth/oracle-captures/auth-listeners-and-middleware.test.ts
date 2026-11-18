import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { deleteApp, FirebaseError, type FirebaseApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import {
  beforeAuthStateChanged,
  getAuth,
  initializeAuth,
  inMemoryPersistence,
  onAuthStateChanged,
  onIdTokenChanged,
  signInWithCustomToken,
  signOut,
  updateProfile,
} from 'pyric/auth';
import { initializeSandbox } from 'pyric/sandbox';
import {
  createListenersAdminSession,
  replayAuthBeforeAuthStateChangedBlockSignInAndSignOut,
  replayAuthBeforeAuthStateChangedOnAbortReverseAndSwallow,
  replayAuthOnAuthStateChangedDuplicateFnAndUnsubDuringEmit,
  replayAuthOnAuthStateChangedSameUidDedupVsIdToken,
  type AuthListenersAndMiddlewareReplayContext,
  type ReplayListenersAndMiddlewareAuthSdk,
} from '../../../../conformance/src/auth-listeners-and-middleware-replay.ts';
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

const PROJECT_ID = 'demo-auth-listeners';
let appCounter = 0;

function inPageListenersContext(): AuthListenersAndMiddlewareReplayContext {
  const sandbox = initializeSandbox();
  const createdApps: FirebaseApp[] = [];
  const createApp = (label: string): FirebaseApp => {
    appCounter += 1;
    const app = createAppForSandbox(
      sandbox,
      { projectId: PROJECT_ID, apiKey: 'demo-inpage-listeners-key' },
      `inpage-listeners-${label}-${appCounter}`,
    );
    createdApps.push(app);
    return app;
  };
  const primaryApp = createApp('primary');
  const auth = getAuth(primaryApp);
  const { adminAuth, cleanup: adminCleanup } = createListenersAdminSession(
    sandbox,
    PROJECT_ID,
    'inpage',
  );
  let seq = 0;

  const authSdk: ReplayListenersAndMiddlewareAuthSdk = {
    inMemoryPersistence,
    initializeAuth: (app, deps) => initializeAuth(app as FirebaseApp, deps) as never,
    signInWithCustomToken: (inst, token) =>
      signInWithCustomToken(inst as never, token) as never,
    signOut: (inst) => signOut(inst as never),
    updateProfile: (user, profile) => updateProfile(user as never, profile),
    onAuthStateChanged: (inst, cb) => onAuthStateChanged(inst as never, cb as never),
    onIdTokenChanged: (inst, cb) => onIdTokenChanged(inst as never, cb as never),
    beforeAuthStateChanged: (inst, cb, onAbort) =>
      beforeAuthStateChanged(inst as never, cb as never, onAbort),
  };

  return {
    auth: auth as never,
    authSdk,
    adminAuth,
    FirebaseError: FirebaseError as unknown as new (...args: never[]) => Error,
    createAuxiliaryApp: (label) => createApp(label),
    nextUid: (label) => {
      seq += 1;
      return `inpage-listeners-${label}-${seq}`;
    },
    cleanup: async () => {
      for (const app of createdApps) {
        try {
          await deleteApp(app);
        } catch {
          // Best-effort cleanup.
        }
      }
      await adminCleanup();
      sandbox.dispose();
    },
  };
}

describe('Auth listeners and beforeAuthStateChanged oracle captures (in-page pyric/auth)', () => {
  it('auth-onauthstatechanged-same-uid-dedup-vs-idtoken (auth#30a, #38a)', async () => {
    const production = load('auth-onauthstatechanged-same-uid-dedup-vs-idtoken');
    const pyric = await replayAuthOnAuthStateChangedSameUidDedupVsIdToken(
      inPageListenersContext(),
    );
    expectReplay({ production, pyric });
  });

  it('auth-onauthstatechanged-duplicate-fn-and-unsub-during-emit (auth#33a, #34)', async () => {
    const production = load('auth-onauthstatechanged-duplicate-fn-and-unsub-during-emit');
    const pyric = await replayAuthOnAuthStateChangedDuplicateFnAndUnsubDuringEmit(
      inPageListenersContext(),
    );
    expectReplay({ production, pyric });
  });

  it('auth-beforeauthstatechanged-block-signin-and-signout (auth#76, #76b)', async () => {
    const production = load('auth-beforeauthstatechanged-block-signin-and-signout');
    const pyric = await replayAuthBeforeAuthStateChangedBlockSignInAndSignOut(
      inPageListenersContext(),
    );
    expectReplay({ production, pyric });
  });

  it('auth-beforeauthstatechanged-onabort-reverse-and-swallow (auth#76a)', async () => {
    const production = load('auth-beforeauthstatechanged-onabort-reverse-and-swallow');
    const pyric = await replayAuthBeforeAuthStateChangedOnAbortReverseAndSwallow(
      inPageListenersContext(),
    );
    expectReplay({ production, pyric });
  });
});
