import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getAuth,
  onAuthStateChanged,
  onIdTokenChanged,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from 'pyric/auth';
import {
  createSandboxAdminAuthSession,
  replayAuthUpdateProfileInPlaceAndPersistence,
  replayAuthUserEmailVerifiedPassthrough,
  replayAuthUserGetIdTokenJwtStructure,
  replayAuthUserGetIdTokenResultClaimsShape,
  replayAuthUserIdentityFieldsBySource,
  replayAuthUserPhotoPhoneAndProviderData,
  type AuthUserMethodsReplayContext,
  type ReplayClientAuthSdk,
} from '../../../../conformance/src/auth-user-methods-replay.ts';
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

function inPageAuthContext(): AuthUserMethodsReplayContext {
  const sandbox = initializeSandbox();
  const auth = getAuth(sandbox);
  const { adminAuth, cleanup } = createSandboxAdminAuthSession(sandbox, 'in-page');
  let seq = 0;

  const authSdk: ReplayClientAuthSdk = {
    signInAnonymously: (inst) => signInAnonymously(inst as never) as never,
    signInWithEmailAndPassword: (inst, email, password) =>
      signInWithEmailAndPassword(inst as never, email, password) as never,
    signOut: (inst) => signOut(inst as never),
    onAuthStateChanged: (inst, cb) => onAuthStateChanged(inst as never, cb as never),
    onIdTokenChanged: (inst, cb) => onIdTokenChanged(inst as never, cb as never),
    updateProfile: (user, profile) => updateProfile(user as never, profile),
  };

  return {
    auth: auth as never,
    authSdk,
    adminAuth,
    nextUid: (label) => {
      seq += 1;
      return `replay-${label}-${seq}`;
    },
    nextEmail: (label) => {
      seq += 1;
      return `replay-${label}-${seq}@example.com`;
    },
    nextPhoneNumber: () => {
      seq += 1;
      const suffix = String(1000000 + seq).slice(-7);
      return `+1555${suffix}`;
    },
    wait: () => new Promise((resolve) => setTimeout(resolve, 10)),
    cleanup,
  };
}

describe('Auth User methods oracle captures (in-page pyric/auth)', () => {
  it('auth-user-getidtoken-jwt-structure (auth#54)', async () => {
    const production = load('auth-user-getidtoken-jwt-structure');
    const pyric = await replayAuthUserGetIdTokenJwtStructure(inPageAuthContext());
    expectReplay({ production, pyric });
  });

  it('auth-user-getidtokenresult-claims-shape (auth#56)', async () => {
    const production = load('auth-user-getidtokenresult-claims-shape');
    const pyric = await replayAuthUserGetIdTokenResultClaimsShape(inPageAuthContext());
    expectReplay({ production, pyric });
  });

  it('auth-user-identity-fields-by-source (auth#57)', async () => {
    const production = load('auth-user-identity-fields-by-source');
    const pyric = await replayAuthUserIdentityFieldsBySource(inPageAuthContext());
    expectReplay({ production, pyric });
  });

  it('auth-user-email-verified-passthrough (auth#58)', async () => {
    const production = load('auth-user-email-verified-passthrough');
    const pyric = await replayAuthUserEmailVerifiedPassthrough(inPageAuthContext());
    expectReplay({ production, pyric });
  });

  it('auth-user-photo-phone-and-provider-data (auth#58a, auth#58b)', async () => {
    const production = load('auth-user-photo-phone-and-provider-data');
    const pyric = await replayAuthUserPhotoPhoneAndProviderData(inPageAuthContext());
    expectReplay({ production, pyric });
  });

  it('auth-updateprofile-in-place-and-persistence (auth#62)', async () => {
    const production = load('auth-updateprofile-in-place-and-persistence');
    const pyric = await replayAuthUpdateProfileInPlaceAndPersistence(inPageAuthContext());
    expectReplay({ production, pyric });
  });
});
