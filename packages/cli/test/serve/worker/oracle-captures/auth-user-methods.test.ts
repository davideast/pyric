import 'fake-indexeddb/auto';
import { describe, it } from 'bun:test';
import * as clientAuth from '../../../../src/serve/worker/client/auth.js';
import { connectClientToHost, makeHostCtx, sleep } from '../integration-support.js';
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
} from '../../../../../conformance/src/auth-user-methods-replay.ts';
import { expectReplay, load, restoreSharedWorker } from './support.ts';

async function servedAuthContext(): Promise<AuthUserMethodsReplayContext> {
  const ctx = await makeHostCtx();
  const { db } = connectClientToHost(ctx, `worker://auth-user-methods-${Math.random()}`);
  const auth = clientAuth.getAuth(db);
  const { adminAuth, cleanup } = createSandboxAdminAuthSession(ctx.sandbox, 'worker');
  let seq = 0;

  const authSdk: ReplayClientAuthSdk = {
    signInAnonymously: (inst) => clientAuth.signInAnonymously(inst as never) as never,
    signInWithEmailAndPassword: (inst, email, password) =>
      clientAuth.signInWithEmailAndPassword(inst as never, email, password) as never,
    signOut: (inst) => clientAuth.signOut(inst as never),
    onAuthStateChanged: (inst, cb) => clientAuth.onAuthStateChanged(inst as never, cb as never),
    onIdTokenChanged: (inst, cb) => clientAuth.onIdTokenChanged(inst as never, cb as never),
    updateProfile: (user, profile) => clientAuth.updateProfile(user as never, profile),
  };

  return {
    auth: auth as never,
    authSdk,
    adminAuth,
    nextUid: (label) => {
      seq += 1;
      return `worker-replay-${label}-${seq}`;
    },
    nextEmail: (label) => {
      seq += 1;
      return `worker-replay-${label}-${seq}@example.com`;
    },
    nextPhoneNumber: () => {
      seq += 1;
      const suffix = String(1000000 + seq).slice(-7);
      return `+1555${suffix}`;
    },
    wait: () => sleep(50),
    cleanup,
  };
}

describe('Auth User methods oracle captures (served worker client + host)', () => {
  restoreSharedWorker();

  it('auth-user-getidtoken-jwt-structure (auth#54)', async () => {
    const production = load('auth-user-getidtoken-jwt-structure');
    const pyric = await replayAuthUserGetIdTokenJwtStructure(await servedAuthContext());
    expectReplay({ production, pyric });
  });

  it('auth-user-getidtokenresult-claims-shape (auth#56)', async () => {
    const production = load('auth-user-getidtokenresult-claims-shape');
    const pyric = await replayAuthUserGetIdTokenResultClaimsShape(await servedAuthContext());
    expectReplay({ production, pyric });
  });

  it('auth-user-identity-fields-by-source (auth#57)', async () => {
    const production = load('auth-user-identity-fields-by-source');
    const pyric = await replayAuthUserIdentityFieldsBySource(await servedAuthContext());
    expectReplay({ production, pyric });
  });

  it('auth-user-email-verified-passthrough (auth#58)', async () => {
    const production = load('auth-user-email-verified-passthrough');
    const pyric = await replayAuthUserEmailVerifiedPassthrough(await servedAuthContext());
    expectReplay({ production, pyric });
  });

  it('auth-user-photo-phone-and-provider-data (auth#58a, auth#58b)', async () => {
    const production = load('auth-user-photo-phone-and-provider-data');
    const pyric = await replayAuthUserPhotoPhoneAndProviderData(await servedAuthContext());
    expectReplay({ production, pyric });
  });

  it('auth-updateprofile-in-place-and-persistence (auth#62)', async () => {
    const production = load('auth-updateprofile-in-place-and-persistence');
    const pyric = await replayAuthUpdateProfileInPlaceAndPersistence(await servedAuthContext());
    expectReplay({ production, pyric });
  });
});
