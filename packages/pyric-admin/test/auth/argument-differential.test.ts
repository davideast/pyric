/**
 * Generative `firebase-admin/auth` vs `pyric-admin/auth` argument differential
 * suite across both local and JSON-wire remote sandbox arms.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import {
  deleteApp as deleteUpstreamApp,
  getApps as getUpstreamApps,
  initializeApp as initializeUpstreamApp,
} from 'firebase-admin/app';
import { getAuth as getUpstreamAuth } from 'firebase-admin/auth';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getAuth } from '../../src/auth/index.js';

import {
  emitTypeWrongnessCandidates,
  generateMethodArgumentCases,
  type CandidateValue,
  type GeneratedArgumentCase,
} from '../argument-generator/argument-combinators.js';
import {
  buildAuthMethodSchemas,
  type AuthMethodSchemas,
} from './auth-argument-schemas.js';
import {
  AUTH_FIXED_NOW_MS,
  createAuthArm,
  type AuthSchemaSeed,
} from './auth-sandbox-arms.js';
import {
  captureAuthOutcome,
  createOfflineUpstreamAuthHarness,
  isDocumentedUnmodeledAuthBackendDiff,
  type NormalizedAuthOutcome,
} from './upstream-auth-oracle.js';

function invokeAppAccessor(
  accessor: (app?: never) => unknown,
  candidate: CandidateValue,
): unknown {
  if (candidate.label === 'undefined') {
    return accessor();
  }
  return accessor(candidate.build() as never);
}

function compareAuthOutcomes(
  contextLabel: string,
  methodName: string,
  rawArgs: readonly unknown[],
  upstream: NormalizedAuthOutcome,
  pyric: NormalizedAuthOutcome,
): string | null {
  if (isDocumentedUnmodeledAuthBackendDiff(methodName, rawArgs, upstream, pyric)) {
    return null;
  }

  if (upstream.accepted !== pyric.accepted) {
    return `${contextLabel}: acceptance mismatch (upstream=${upstream.accepted} code=${upstream.code ?? upstream.errorKind}, pyric=${pyric.accepted} code=${pyric.code ?? pyric.errorKind})`;
  }

  if (!upstream.accepted && !pyric.accepted) {
    if (upstream.errorKind === 'TypeError' && pyric.errorKind === 'TypeError') {
      return null;
    }
    if (upstream.code !== undefined && upstream.code === pyric.code) {
      return null;
    }
    return `${contextLabel}: error mismatch (upstream=${upstream.errorKind}:${upstream.code}, pyric=${pyric.errorKind}:${pyric.code})`;
  }

  return null;
}

afterEach(async () => {
  for (const app of getApps()) {
    try {
      await deleteApp(app);
    } catch {}
  }
  for (const app of getUpstreamApps()) {
    try {
      await deleteUpstreamApp(app);
    } catch {}
  }
});

describe('generative Admin Auth argument differential: getAuth', () => {
  it('matches firebase-admin across all generated app-handle wrong types, no-app, default-app, and deleted-app states', async () => {
    const mismatches: string[] = [];

    for (const candidate of emitTypeWrongnessCandidates()) {
      const uGet = await captureAuthOutcome(() =>
        invokeAppAccessor(getUpstreamAuth as (app?: never) => unknown, candidate),
      );
      const pGet = await captureAuthOutcome(() =>
        invokeAppAccessor(getAuth as (app?: never) => unknown, candidate),
      );

      const getDiff = compareAuthOutcomes(
        `getAuth(${candidate.label})`,
        'getAuth',
        [candidate.value],
        uGet,
        pGet,
      );
      if (getDiff !== null) mismatches.push(getDiff);
    }

    const upstreamHarness = createOfflineUpstreamAuthHarness();
    const defaultUpstream = initializeUpstreamApp({
      projectId: 'demo-project',
      credential: upstreamHarness.app.options.credential,
    });
    const sandbox = initializeSandbox({ projectId: 'demo-project' });
    const defaultPyric = initializeApp({ sandbox, projectId: 'demo-project' });
    try {
      const uDef = await captureAuthOutcome(() => getUpstreamAuth());
      const pDef = await captureAuthOutcome(() => getAuth());
      const defDiff = compareAuthOutcomes('getAuth([DEFAULT])', 'getAuth', [], uDef, pDef);
      if (defDiff !== null) mismatches.push(defDiff);
    } finally {
      await deleteUpstreamApp(defaultUpstream);
      await deleteApp(defaultPyric);
      await upstreamHarness.dispose();
      sandbox.dispose();
    }

    const delHarness = createOfflineUpstreamAuthHarness();
    const delSandbox = initializeSandbox({ projectId: 'demo-project' });
    const delUpstream = initializeUpstreamApp(
      { projectId: 'demo-project', credential: delHarness.app.options.credential },
      'deleted-upstream-auth',
    );
    const delPyric = initializeApp(
      { sandbox: delSandbox, projectId: 'demo-project' },
      'deleted-pyric-auth',
    );
    await deleteUpstreamApp(delUpstream);
    await deleteApp(delPyric);
    try {
      const uDel = await captureAuthOutcome(() => getUpstreamAuth(delUpstream));
      const pDel = await captureAuthOutcome(() => getAuth(delPyric));
      const delDiff = compareAuthOutcomes('getAuth(deletedApp)', 'getAuth', [delPyric], uDel, pDel);
      if (delDiff !== null) mismatches.push(delDiff);
    } finally {
      await delHarness.dispose();
      delSandbox.dispose();
    }

    expect(mismatches).toEqual([]);
  });
});

for (const armKind of ['local', 'remote'] as const) {
  describe(`generative Admin Auth argument differential (${armKind} sandbox arm)`, () => {
    async function assertAuthMethodParity(
      selectCases: (
        schemas: AuthMethodSchemas,
        seed: AuthSchemaSeed,
      ) => readonly GeneratedArgumentCase[],
    ): Promise<void> {
      const arm = createAuthArm(armKind);
      const upstream = createOfflineUpstreamAuthHarness();

      try {
        const initialSeed = await arm.resetAndSeed();
        const schemas = buildAuthMethodSchemas(initialSeed);
        const cases = selectCases(schemas, initialSeed);
        expect(cases.length).toBeGreaterThan(0);

        const mismatches: string[] = [];
        const nowSec = Math.floor(AUTH_FIXED_NOW_MS / 1000);

        for (const testCase of cases) {
          await arm.resetAndSeed();
          upstream.resetState(
            [
              { uid: 'user-1', email: 'user-1@example.com', validSinceSec: nowSec },
              { uid: 'user-2', email: 'user-2@example.com', validSinceSec: nowSec },
            ],
            nowSec,
          );

          const upstreamArgs = testCase.buildArgs();
          const pyricArgs = testCase.buildArgs();

          upstream.resetTransportFlag();
          const upstreamFn = (
            upstream.svc as unknown as Record<string, (...a: unknown[]) => unknown>
          )[testCase.methodName];
          const pyricFn = (
            arm.svc as unknown as Record<string, (...a: unknown[]) => unknown>
          )[testCase.methodName];

          const uOutcome = await captureAuthOutcome(
            () => upstreamFn?.apply(upstream.svc, upstreamArgs),
            upstream.didReachTransport,
          );
          const pOutcome = await captureAuthOutcome(() =>
            pyricFn?.apply(arm.svc, pyricArgs),
          );

          const diff = compareAuthOutcomes(
            `${testCase.methodName}:${testCase.label}`,
            testCase.methodName,
            pyricArgs,
            uOutcome,
            pOutcome,
          );
          if (diff !== null) {
            mismatches.push(diff);
          }
        }

        expect(mismatches).toEqual([]);
      } finally {
        await upstream.dispose();
        await arm.dispose();
      }
    }

    it('matches firebase-admin on createCustomToken & setCustomUserClaims across uids, reserved claims, undefined stripping, and payload cap', async () => {
      await assertAuthMethodParity((schemas) => [
        ...generateMethodArgumentCases(schemas.createCustomToken),
        ...generateMethodArgumentCases(schemas.setCustomUserClaims),
      ]);

      const arm = createAuthArm(armKind);
      try {
        const seed = await arm.resetAndSeed();
        await arm.svc.setCustomUserClaims(seed.existingUid, { dropped: undefined } as never);
        const afterUndefinedOnly = await arm.svc.getUser(seed.existingUid);
        expect(afterUndefinedOnly.customClaims).toBeUndefined();
      } finally {
        await arm.dispose();
      }
    });

    it('matches firebase-admin on createUser & updateUser across containers, fields, URLs, phones, MFA, and provider links', async () => {
      await assertAuthMethodParity((schemas) => [
        ...generateMethodArgumentCases(schemas.createUser),
        ...generateMethodArgumentCases(schemas.updateUser),
      ]);
    });

    it('matches firebase-admin on getUser, getUserByEmail, deleteUser, revokeRefreshTokens, listUsers, and verifyIdToken', async () => {
      await assertAuthMethodParity((schemas) => [
        ...generateMethodArgumentCases(schemas.getUser),
        ...generateMethodArgumentCases(schemas.getUserByEmail),
        ...generateMethodArgumentCases(schemas.deleteUser),
        ...generateMethodArgumentCases(schemas.revokeRefreshTokens),
        ...generateMethodArgumentCases(schemas.listUsers),
        ...generateMethodArgumentCases(schemas.verifyIdToken),
      ]);
    });

    it('matches firebase-admin listUsers(1, pageToken) progression when either the last-returned or next-boundary user is deleted', async () => {
      const arm = createAuthArm(armKind);
      const upstream = createOfflineUpstreamAuthHarness();
      try {
        // Subcase 1: deleteLastReturnedUser ([a1, a2, a3] -> delete a1 -> [a2], [a3])
        await arm.resetAndSeed();
        await arm.svc.deleteUser('user-1');
        await arm.svc.deleteUser('user-2');
        upstream.resetState([]);
        for (const uid of ['a1', 'a2', 'a3']) {
          await arm.svc.createUser({ uid });
          await upstream.svc.createUser({ uid });
        }

        const uPageA1 = await upstream.svc.listUsers(1);
        const pPageA1 = await arm.svc.listUsers(1);
        expect(pPageA1.users.map((u) => u.uid)).toEqual(uPageA1.users.map((u) => u.uid));
        expect(pPageA1.users.map((u) => u.uid)).toEqual(['a1']);

        await upstream.svc.deleteUser('a1');
        await arm.svc.deleteUser('a1');

        const uPageA2 = await upstream.svc.listUsers(1, uPageA1.pageToken);
        const pPageA2 = await arm.svc.listUsers(1, pPageA1.pageToken);
        expect(pPageA2.users.map((u) => u.uid)).toEqual(uPageA2.users.map((u) => u.uid));
        expect(pPageA2.users.map((u) => u.uid)).toEqual(['a2']);

        const uPageA3 = await upstream.svc.listUsers(1, uPageA2.pageToken);
        const pPageA3 = await arm.svc.listUsers(1, pPageA2.pageToken);
        expect(pPageA3.users.map((u) => u.uid)).toEqual(uPageA3.users.map((u) => u.uid));
        expect(pPageA3.users.map((u) => u.uid)).toEqual(['a3']);
        expect(pPageA3.pageToken).toBe(uPageA3.pageToken);
        expect(pPageA3.pageToken).toBeUndefined();

        // Subcase 2: deleteNextBoundaryUser ([b1, b2, b3] -> delete b2 -> [b3])
        await arm.resetAndSeed();
        await arm.svc.deleteUser('user-1');
        await arm.svc.deleteUser('user-2');
        upstream.resetState([]);
        for (const uid of ['b1', 'b2', 'b3']) {
          await arm.svc.createUser({ uid });
          await upstream.svc.createUser({ uid });
        }

        const uPageB1 = await upstream.svc.listUsers(1);
        const pPageB1 = await arm.svc.listUsers(1);
        expect(pPageB1.users.map((u) => u.uid)).toEqual(uPageB1.users.map((u) => u.uid));
        expect(pPageB1.users.map((u) => u.uid)).toEqual(['b1']);

        await upstream.svc.deleteUser('b2');
        await arm.svc.deleteUser('b2');

        const uPageB2 = await upstream.svc.listUsers(1, uPageB1.pageToken);
        const pPageB2 = await arm.svc.listUsers(1, pPageB1.pageToken);
        expect(pPageB2.users.map((u) => u.uid)).toEqual(uPageB2.users.map((u) => u.uid));
        expect(pPageB2.users.map((u) => u.uid)).toEqual(['b3']);
        expect(pPageB2.pageToken).toBe(uPageB2.pageToken);
        expect(pPageB2.pageToken).toBeUndefined();
      } finally {
        await upstream.dispose();
        await arm.dispose();
      }
    });

    it('matches firebase-admin preflight on getUserByPhoneNumber, getUsers [0,1,100,101], and deleteUsers [0,1,1000,1001]', async () => {
      await assertAuthMethodParity((schemas) => [
        ...generateMethodArgumentCases(schemas.getUserByPhoneNumber),
        ...generateMethodArgumentCases(schemas.getUsers),
        ...generateMethodArgumentCases(schemas.deleteUsers),
      ]);
    });

    it('matches firebase-admin preflight on createSessionCookie, verifySessionCookie, and email action-link generators', async () => {
      await assertAuthMethodParity((schemas) => [
        ...generateMethodArgumentCases(schemas.createSessionCookie),
        ...generateMethodArgumentCases(schemas.verifySessionCookie),
        ...generateMethodArgumentCases(schemas.generatePasswordResetLink),
        ...generateMethodArgumentCases(schemas.generateEmailVerificationLink),
        ...generateMethodArgumentCases(schemas.generateSignInWithEmailLink),
        ...generateMethodArgumentCases(schemas.generateVerifyAndChangeEmailLink),
      ]);
    });
  });
}
