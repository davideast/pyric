import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { deleteApp, FirebaseError, type FirebaseApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import * as pyricAuth from 'pyric/auth';
import { initializeSandbox } from 'pyric/sandbox';
import {
  createProvidersAdminSession,
  replayAuthCredentialFactoriesAndJsonRoundtrip,
  replayAuthEmailCredentialSigninAndProviderdata,
  replayAuthProviderClassesAndSamlGuard,
  type AuthProvidersAndCredentialsReplayContext,
  type ReplayProvidersAndCredentialsAuthSdk,
} from '../../../../conformance/src/auth-providers-and-credentials-replay.ts';
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

const PROJECT_ID = 'demo-auth-providers';
let appCounter = 0;

function inPageProvidersContext(): AuthProvidersAndCredentialsReplayContext {
  const sandbox = initializeSandbox();
  appCounter += 1;
  const app: FirebaseApp = createAppForSandbox(
    sandbox,
    { projectId: PROJECT_ID, apiKey: 'demo-inpage-providers-key' },
    `inpage-providers-${appCounter}`,
  );
  const auth = pyricAuth.getAuth(app);
  const { adminAuth, cleanup: adminCleanup } = createProvidersAdminSession(
    sandbox,
    PROJECT_ID,
    'inpage',
  );
  let seq = 0;

  return {
    auth,
    authSdk: pyricAuth as unknown as ReplayProvidersAndCredentialsAuthSdk,
    adminAuth,
    FirebaseError,
    nextUid: (label) => {
      seq += 1;
      return `inpage-prov-${label}-${seq}`;
    },
    nextEmail: (label) => {
      seq += 1;
      return `inpage-prov-${label}-${seq}@example.com`;
    },
    cleanup: async () => {
      try {
        await deleteApp(app);
      } catch {
        // Best-effort cleanup.
      }
      await adminCleanup();
      sandbox.dispose();
    },
  };
}

describe('Auth provider classes, credentials, and providerData oracle captures (in-page pyric/auth)', () => {
  it('auth-provider-classes-and-saml-guard (auth#50, #52, #181)', async () => {
    const production = load('auth-provider-classes-and-saml-guard');
    const pyric = await replayAuthProviderClassesAndSamlGuard(inPageProvidersContext());
    expectReplay({ production, pyric });
  });

  it('auth-credential-factories-and-json-roundtrip (auth#51, #180, #181)', async () => {
    const production = load('auth-credential-factories-and-json-roundtrip');
    const pyric = await replayAuthCredentialFactoriesAndJsonRoundtrip(inPageProvidersContext());
    expectReplay({ production, pyric });
  });

  it('auth-email-credential-signin-and-providerdata (auth#180, #182)', async () => {
    const production = load('auth-email-credential-signin-and-providerdata');
    const pyric = await replayAuthEmailCredentialSigninAndProviderdata(inPageProvidersContext());
    expectReplay({ production, pyric });
  });
});
