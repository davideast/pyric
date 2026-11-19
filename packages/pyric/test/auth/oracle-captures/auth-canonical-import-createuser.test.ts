import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { deleteApp as deleteCanonicalApp, initializeApp as initializeCanonicalApp } from 'firebase/app';
import { deleteApp, type FirebaseApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import * as pyricAuth from 'pyric/auth';
import { initializeSandbox } from 'pyric/sandbox';
import {
  replayAuthCanonicalImportAndCreateUserShape,
  type AuthCanonicalImportCreateUserReplayContext,
  type ReplayCreateUserAuthSdk,
} from '../../../../conformance/src/auth-canonical-import-createuser-replay.ts';
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

const PROJECT_ID = 'demo-auth-canonical-createuser';
let appCounter = 0;

function inPageCanonicalCreateUserContext(): AuthCanonicalImportCreateUserReplayContext {
  const sandbox = initializeSandbox();
  appCounter += 1;
  const createdApps: FirebaseApp[] = [];
  const app = createAppForSandbox(
    sandbox,
    { projectId: PROJECT_ID, apiKey: 'demo-inpage-canonical-createuser-key' },
    `inpage-canonical-createuser-${appCounter}`,
  );
  createdApps.push(app);
  const auth = pyricAuth.getAuth(app);
  let seq = 0;

  return {
    auth,
    authSdk: pyricAuth as unknown as ReplayCreateUserAuthSdk,
    nextEmail: (label) => {
      seq += 1;
      return `inpage-cic-${label}-${seq}@example.com`;
    },
    cleanup: async () => {
      for (const candidate of createdApps) {
        try {
          await deleteApp(candidate);
        } catch {
          // Best-effort cleanup.
        }
      }
      sandbox.dispose();
    },
  };
}

describe('Auth canonical import boundary and createUserWithEmailAndPassword shape oracle capture (in-page pyric/auth)', () => {
  it('auth-canonical-import-and-createuser-shape (auth#3, auth#20, auth#23)', async () => {
    const production = load('auth-canonical-import-and-createuser-shape');
    const pyric = await replayAuthCanonicalImportAndCreateUserShape(
      inPageCanonicalCreateUserContext(),
    );
    expectReplay({ production, pyric });
  });

  it('rejects unswapped canonical firebase/app handles at the pyric/auth mirror boundary (auth#3)', async () => {
    appCounter += 1;
    const canonicalApp = initializeCanonicalApp(
      {
        apiKey: 'AIzaSyDummyMirrorBoundaryKey0000000000',
        authDomain: 'demo-mirror-boundary.firebaseapp.com',
        projectId: 'demo-mirror-boundary',
        appId: '1:0:web:0',
      },
      `mirror-boundary-${appCounter}`,
    );
    try {
      expect(() => pyricAuth.getAuth(canonicalApp as never)).toThrow(
        /sandbox-only mirror.*Package resolution/s,
      );
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 15);
      });
    } finally {
      await deleteCanonicalApp(canonicalApp).catch(() => undefined);
    }
  });
});
