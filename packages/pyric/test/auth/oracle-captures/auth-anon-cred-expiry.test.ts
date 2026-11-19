import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { deleteApp, FirebaseError, type FirebaseApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import * as pyricAuth from 'pyric/auth';
import { initializeSandbox } from 'pyric/sandbox';
import { getClock } from 'pyric/sandbox/internal';
import {
  createAnonCredExpiryAdminSession,
  replayAuthAnonymousIdempotencyAndRemint,
  replayAuthCredentialSignInRichUserAndDisabledGuard,
  replayAuthGetIdTokenExpiryBufferRefresh,
  type AuthAnonCredExpiryReplayContext,
  type ReplayAnonCredExpiryAuthSdk,
} from '../../../../conformance/src/auth-anon-cred-expiry-replay.ts';
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

const PROJECT_ID = 'demo-auth-anon-cred-expiry';
let appCounter = 0;

function inPageAnonCredExpiryContext(): AuthAnonCredExpiryReplayContext {
  const sandbox = initializeSandbox();
  const clock = getClock(sandbox);
  clock.set(Date.UTC(2026, 0, 1));
  appCounter += 1;
  const createdApps: FirebaseApp[] = [];
  const app = createAppForSandbox(
    sandbox,
    { projectId: PROJECT_ID, apiKey: 'demo-inpage-anon-cred-expiry-key' },
    `inpage-anon-cred-expiry-${appCounter}`,
  );
  createdApps.push(app);
  const auth = pyricAuth.getAuth(app);
  const { adminAuth, cleanup: adminCleanup } = createAnonCredExpiryAdminSession(
    sandbox,
    PROJECT_ID,
    'inpage',
  );
  let seq = 0;

  return {
    auth,
    authSdk: pyricAuth as unknown as ReplayAnonCredExpiryAuthSdk,
    adminAuth,
    FirebaseError,
    advanceClock: async (ms: number) => {
      clock.advance(ms);
    },
    settle: async () => {
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    },
    nextUid: (label) => {
      seq += 1;
      return `inpage-ace-${label}-${seq}`;
    },
    nextEmail: (label) => {
      seq += 1;
      return `inpage-ace-${label}-${seq}@example.com`;
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

describe('Auth anonymous idempotency/remint, credential sign-in rich user/disabled guard, and token expiry buffer oracle captures (in-page pyric/auth)', () => {
  it('auth-getidtoken-expiry-buffer-refresh (auth#55a)', async () => {
    const production = load('auth-getidtoken-expiry-buffer-refresh');
    const pyric = await replayAuthGetIdTokenExpiryBufferRefresh(inPageAnonCredExpiryContext());
    expectReplay({ production, pyric });
  });

  it('auth-anonymous-idempotency-and-remint (auth#8, auth#9)', async () => {
    const production = load('auth-anonymous-idempotency-and-remint');
    const pyric = await replayAuthAnonymousIdempotencyAndRemint(inPageAnonCredExpiryContext());
    expectReplay({ production, pyric });
  });

  it('auth-credential-signin-rich-user-and-disabled-guard (auth#47a, auth#70)', async () => {
    const production = load('auth-credential-signin-rich-user-and-disabled-guard');
    const pyric = await replayAuthCredentialSignInRichUserAndDisabledGuard(
      inPageAnonCredExpiryContext(),
    );
    expectReplay({ production, pyric });
  });
});
