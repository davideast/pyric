import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { deleteApp, FirebaseError, type FirebaseApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import {
  deleteUser,
  getAuth,
  initializeAuth,
  inMemoryPersistence,
  onAuthStateChanged,
  reload,
  signInWithEmailAndPassword,
  signOut,
  updateCurrentUser,
} from 'pyric/auth';
import { initializeSandbox } from 'pyric/sandbox';
import {
  createUserManagementAdminSession,
  replayAuthDeleteUserSignOutAndFollowupErrors,
  replayAuthInitializeAuthLifecycleAndDeps,
  replayAuthReloadOutOfBandAndDisabledDeleted,
  replayAuthUpdateCurrentUserSetAndNullSignOut,
  type AuthUserManagementReplayContext,
  type ReplayUserManagementAuthSdk,
} from '../../../../conformance/src/auth-user-management-replay.ts';
import {
  replayMismatches,
  type Behavior,
  type Replay,
} from '../../../../conformance/src/capture/sdk-scenarios/replay-comparison.ts';

/** Reads a committed auth capture by stem; the auth completeness gate counts this call as coverage. */
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

let appCounter = 0;

function inPageUserManagementContext(): AuthUserManagementReplayContext {
  const sandbox = initializeSandbox();
  const createdApps: FirebaseApp[] = [];
  const createApp = (label: string): FirebaseApp => {
    appCounter += 1;
    const app = createAppForSandbox(
      sandbox,
      { projectId: 'demo-auth-user-management', apiKey: 'demo-inpage-api-key' },
      `inpage-mgmt-${label}-${appCounter}`,
    );
    createdApps.push(app);
    return app;
  };
  const primaryApp = createApp('primary');
  const auth = getAuth(primaryApp);
  const { adminAuth, cleanup: adminCleanup } = createUserManagementAdminSession(sandbox, 'inpage');
  let seq = 0;

  const authSdk: ReplayUserManagementAuthSdk = {
    inMemoryPersistence,
    getAuth: (app) => getAuth(app as FirebaseApp) as never,
    initializeAuth: (app, deps) => initializeAuth(app as FirebaseApp, deps) as never,
    signInWithEmailAndPassword: (inst, email, password) =>
      signInWithEmailAndPassword(inst as never, email, password) as never,
    signOut: (inst) => signOut(inst as never),
    onAuthStateChanged: (inst, cb) => onAuthStateChanged(inst as never, cb as never),
    deleteUser: (user) => deleteUser(user as never),
    reload: (user) => reload(user as never),
    updateCurrentUser: (inst, user) => updateCurrentUser(inst as never, user as never),
  };

  return {
    auth: auth as never,
    authSdk,
    adminAuth,
    FirebaseError: FirebaseError as unknown as new (...args: never[]) => Error,
    createAuxiliaryApp: (label) => createApp(label),
    nextUid: (label) => {
      seq += 1;
      return `inpage-mgmt-${label}-${seq}`;
    },
    nextEmail: (label) => {
      seq += 1;
      return `inpage-mgmt-${label}-${seq}@example.com`;
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

describe('Auth user-management and session oracle captures (in-page pyric/auth)', () => {
  it('auth-initializeauth-lifecycle-and-deps (auth#82)', async () => {
    const production = load('auth-initializeauth-lifecycle-and-deps');
    const pyric = await replayAuthInitializeAuthLifecycleAndDeps(inPageUserManagementContext());
    expectReplay({ production, pyric });
  });

  it('auth-deleteuser-signout-and-followup-errors (auth#83)', async () => {
    const production = load('auth-deleteuser-signout-and-followup-errors');
    const pyric = await replayAuthDeleteUserSignOutAndFollowupErrors(
      inPageUserManagementContext(),
    );
    expectReplay({ production, pyric });
  });

  it('auth-reload-out-of-band-and-disabled-deleted (auth#86)', async () => {
    const production = load('auth-reload-out-of-band-and-disabled-deleted');
    const pyric = await replayAuthReloadOutOfBandAndDisabledDeleted(inPageUserManagementContext());
    expectReplay({ production, pyric });
  });

  it('auth-updatecurrentuser-set-and-null-signout (auth#87)', async () => {
    const production = load('auth-updatecurrentuser-set-and-null-signout');
    const pyric = await replayAuthUpdateCurrentUserSetAndNullSignOut(
      inPageUserManagementContext(),
    );
    expectReplay({ production, pyric });
  });
});
