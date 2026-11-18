import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { deleteApp, FirebaseError, type FirebaseApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import * as pyricAuth from 'pyric/auth';
import { initializeSandbox } from 'pyric/sandbox';
import {
  createHandlesAdminSession,
  replayAuthDisabledAccountSignInAndRefresh,
  replayAuthHandleCachingLiveCurrentUserAndReSignIn,
  replayAuthSetPersistenceAndFirebaseErrorWrapper,
  type AuthHandlesPersistenceDisabledReplayContext,
  type ReplayHandlesPersistenceDisabledAuthSdk,
} from '../../../../conformance/src/auth-handles-persistence-disabled-replay.ts';
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

const PROJECT_ID = 'demo-auth-handles';
let appCounter = 0;

function inPageHandlesContext(): AuthHandlesPersistenceDisabledReplayContext {
  const sandbox = initializeSandbox();
  appCounter += 1;
  const createdApps: FirebaseApp[] = [];
  const makeApp = (label: string): FirebaseApp => {
    appCounter += 1;
    const nextApp = createAppForSandbox(
      sandbox,
      { projectId: PROJECT_ID, apiKey: 'demo-inpage-handles-key' },
      `inpage-handles-${label}-${appCounter}`,
    );
    createdApps.push(nextApp);
    return nextApp;
  };
  const app = makeApp('primary');
  const auth = pyricAuth.getAuth(app);
  const { adminAuth, cleanup: adminCleanup } = createHandlesAdminSession(
    sandbox,
    PROJECT_ID,
    'inpage',
  );
  let seq = 0;

  return {
    auth,
    authSdk: pyricAuth as unknown as ReplayHandlesPersistenceDisabledAuthSdk,
    adminAuth,
    FirebaseError,
    createAuxiliaryClientApp: (label) => makeApp(label),
    nextUid: (label) => {
      seq += 1;
      return `inpage-hpd-${label}-${seq}`;
    },
    nextEmail: (label) => {
      seq += 1;
      return `inpage-hpd-${label}-${seq}@example.com`;
    },
    cleanup: async () => {
      for (const candidate of createdApps) {
        try {
          await deleteApp(candidate);
        } catch {
          // Best-effort cleanup.
        }
      }
      await adminCleanup();
      sandbox.dispose();
    },
  };
}

describe('Auth handle caching, persistence markers, FirebaseError wrapper, and disabled-account oracle captures (in-page pyric/auth)', () => {
  it('auth-handle-caching-live-currentuser-and-resignin (auth#1, #5, #16, #49e)', async () => {
    const production = load('auth-handle-caching-live-currentuser-and-resignin');
    const pyric = await replayAuthHandleCachingLiveCurrentUserAndReSignIn(inPageHandlesContext());
    expectReplay({ production, pyric });
  });

  it('auth-setpersistence-and-firebaseerror-wrapper (auth#41, #42, #49f)', async () => {
    const production = load('auth-setpersistence-and-firebaseerror-wrapper');
    const pyric = await replayAuthSetPersistenceAndFirebaseErrorWrapper(inPageHandlesContext());
    expectReplay({ production, pyric });
  });

  it('auth-disabled-account-signin-and-refresh (auth#69)', async () => {
    const production = load('auth-disabled-account-signin-and-refresh');
    const pyric = await replayAuthDisabledAccountSignInAndRefresh(inPageHandlesContext());
    expectReplay({ production, pyric });
  });
});
