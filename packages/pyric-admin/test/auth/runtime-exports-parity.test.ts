/**
 * Runtime export, error-class, and nominal-constructor parity against the
 * installed `firebase-admin/auth` (`v13.10.0`) across local and worker-bridge
 * remote sandbox arms (`auth-admin#14`).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import upstreamAdmin from 'firebase-admin';
import {
  Auth as UpstreamAuth,
  AuthClientErrorCode as UpstreamAuthClientErrorCode,
  BaseAuth as UpstreamBaseAuth,
  FirebaseAuthError as UpstreamFirebaseAuthError,
} from 'firebase-admin/auth';
import { initializeSandbox } from 'pyric/sandbox';
import pyricAdmin, { auth as namedRootAuth } from '../../src/index.js';
import { FirebaseError, PrefixedFirebaseError } from '../../src/app/firebase-error.js';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import {
  Auth,
  AuthClientErrorCode,
  BaseAuth,
  FirebaseAuthError,
  getAuth,
  UserInfo,
  UserMetadata,
  UserRecord,
  type AuthErrorCodeInfo,
} from '../../src/auth/index.js';
import { createWorkerBridgeRemoteAuth } from './worker-bridge-helper.js';

const BUILTIN_FUNCTION_PROPS = new Set(['length', 'name', 'prototype']);

function staticErrorCodeKeys(target: object): string[] {
  return Object.getOwnPropertyNames(target)
    .filter((key) => !BUILTIN_FUNCTION_PROPS.has(key))
    .sort();
}

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('pyric-admin/auth runtime exports against firebase-admin/auth 13.10.0', () => {
  it('matches every static AuthClientErrorCode key and { code, message } entry in firebase-admin/auth', () => {
    expect(typeof AuthClientErrorCode).toBe('function');
    const upstreamKeys = staticErrorCodeKeys(UpstreamAuthClientErrorCode);
    const pyricKeys = staticErrorCodeKeys(AuthClientErrorCode);
    expect(pyricKeys).toEqual(upstreamKeys);
    expect(pyricKeys.length).toBe(95);

    const upstreamMap = UpstreamAuthClientErrorCode as unknown as Record<string, AuthErrorCodeInfo>;
    const pyricMap = AuthClientErrorCode as unknown as Record<string, AuthErrorCodeInfo>;
    for (const key of upstreamKeys) {
      expect(pyricMap[key]).toEqual(upstreamMap[key]);
    }
  });

  it('matches FirebaseAuthError constructor, prototype chain, hasCode, and toJSON behavior', () => {
    const UpstreamCtor = UpstreamFirebaseAuthError as unknown as new (
      info: AuthErrorCodeInfo,
      message?: string,
    ) => Error & {
      readonly code: string;
      readonly codePrefix: string;
      readonly errorInfo: AuthErrorCodeInfo;
      hasCode(code: string): boolean;
      toJSON(): AuthErrorCodeInfo;
    };

    const uDefault = new UpstreamCtor(UpstreamAuthClientErrorCode.USER_NOT_FOUND);
    const pDefault = new FirebaseAuthError(AuthClientErrorCode.USER_NOT_FOUND);

    expect(pDefault).toBeInstanceOf(Error);
    expect(pDefault).toBeInstanceOf(FirebaseError);
    expect(pDefault).toBeInstanceOf(PrefixedFirebaseError);
    expect(pDefault).toBeInstanceOf(FirebaseAuthError);
    expect(pDefault.name).toBe(uDefault.name);
    expect(pDefault.code).toBe(uDefault.code);
    expect(pDefault.codePrefix).toBe(uDefault.codePrefix);
    expect(pDefault.message).toBe(uDefault.message);
    expect(pDefault.errorInfo).toEqual(uDefault.errorInfo);
    expect(pDefault.hasCode('user-not-found')).toBe(uDefault.hasCode('user-not-found'));
    expect(pDefault.hasCode('argument-error')).toBe(uDefault.hasCode('argument-error'));
    expect(pDefault.toJSON()).toEqual(uDefault.toJSON());
    expect(Object.keys(pDefault).sort()).toEqual(Object.keys(uDefault).sort());

    const uOverride = new UpstreamCtor(
      UpstreamAuthClientErrorCode.INVALID_ARGUMENT,
      'Custom validation message.',
    );
    const pOverride = new FirebaseAuthError(
      AuthClientErrorCode.INVALID_ARGUMENT,
      'Custom validation message.',
    );
    expect(pOverride.code).toBe(uOverride.code);
    expect(pOverride.message).toBe(uOverride.message);
    expect(pOverride.toJSON()).toEqual(uOverride.toJSON());

    const pEmptyOverride = new FirebaseAuthError(AuthClientErrorCode.USER_DISABLED, '');
    const uEmptyOverride = new UpstreamCtor(UpstreamAuthClientErrorCode.USER_DISABLED, '');
    expect(pEmptyOverride.message).toBe(uEmptyOverride.message);
  });

  it('aligns Auth extends BaseAuth prototype inheritance and admin.auth.Auth root attachment', () => {
    expect(Object.getPrototypeOf(UpstreamAuth)).toBe(UpstreamBaseAuth);
    expect(Object.getPrototypeOf(Auth)).toBe(BaseAuth);
    expect(Object.getPrototypeOf(Auth.prototype)).toBe(BaseAuth.prototype);

    const upstreamAdminAuth = upstreamAdmin.auth as unknown as { Auth?: unknown };
    expect(upstreamAdminAuth.Auth).toBe(UpstreamAuth);
    expect(pyricAdmin.auth.Auth).toBe(Auth);
    expect(namedRootAuth.Auth).toBe(Auth);
  });

  it('returns Auth/BaseAuth handles, UserRecord/UserMetadata/UserInfo instances, and FirebaseAuthError throws across local and remote arms', async () => {
    const localSandbox = initializeSandbox();
    const remoteStack = await createWorkerBridgeRemoteAuth('exports-parity-remote');

    try {
      const localApp = initializeApp({ sandbox: localSandbox }, 'exports-parity-local');
      const arms: ReadonlyArray<{ label: string; auth: Auth }> = [
        { label: 'local', auth: getAuth(localApp) },
        { label: 'remote', auth: remoteStack.auth },
      ];

      for (const { label, auth } of arms) {
        expect(auth instanceof Auth, `${label}: auth instanceof Auth`).toBe(true);
        expect(auth instanceof BaseAuth, `${label}: auth instanceof BaseAuth`).toBe(true);

        const uid = `parity-${label}-u1`;
        const email = `${uid}@example.com`;
        const created = await auth.createUser({
          uid,
          email,
          password: 'secret-password',
          displayName: 'Parity User',
          photoURL: 'https://example.com/avatar.png',
          phoneNumber: '+15555550199',
        });
        await auth.setCustomUserClaims(uid, { role: 'reviewer' });

        const byUid = await auth.getUser(uid);
        const byEmail = await auth.getUserByEmail(email.toUpperCase());
        const updated = await auth.updateUser(uid, { displayName: 'Updated Parity User' });
        const listed = await auth.listUsers(10);
        const listedHit = listed.users.find((entry) => entry.uid === uid);
        expect(listedHit).toBeDefined();
        if (listedHit === undefined) {
          throw new Error(`Expected ${uid} in listUsers on ${label} arm`);
        }

        for (const record of [created, byUid, byEmail, updated, listedHit]) {
          expect(record instanceof UserRecord, `${label}: record instanceof UserRecord`).toBe(true);
          expect(
            record.metadata instanceof UserMetadata,
            `${label}: metadata instanceof UserMetadata`,
          ).toBe(true);
          expect(record.providerData.length).toBeGreaterThan(0);
          for (const info of record.providerData) {
            expect(info instanceof UserInfo, `${label}: providerData entry instanceof UserInfo`).toBe(
              true,
            );
          }
        }

        const json = updated.toJSON();
        expect(json).toMatchObject({
          uid,
          email,
          emailVerified: false,
          displayName: 'Updated Parity User',
          photoURL: 'https://example.com/avatar.png',
          phoneNumber: '+15555550199',
          disabled: false,
          customClaims: { role: 'reviewer' },
          tenantId: null,
        });
        expect(Array.isArray(json.providerData)).toBe(true);

        const syncFailureOps: ReadonlyArray<{ name: string; run: () => unknown }> = [
          { name: 'createCustomToken("")', run: () => auth.createCustomToken('') },
          { name: 'verifyIdToken(123)', run: () => auth.verifyIdToken(123 as never) },
          { name: 'verifySessionCookie(123)', run: () => auth.verifySessionCookie(123 as never) },
          { name: 'getUsers("bad")', run: () => auth.getUsers('bad' as never) },
          { name: 'deleteUsers("bad")', run: () => auth.deleteUsers('bad' as never) },
        ];
        for (const op of syncFailureOps) {
          let caught: unknown;
          try {
            op.run();
          } catch (err) {
            caught = err;
          }
          expect(
            caught instanceof FirebaseAuthError,
            `${label} ${op.name} sync throw instanceof FirebaseAuthError`,
          ).toBe(true);
        }

        const asyncFailureOps: ReadonlyArray<{
          name: string;
          expectedShortCode: string;
          run: () => Promise<unknown>;
        }> = [
          {
            name: 'verifyIdToken("malformed")',
            expectedShortCode: 'argument-error',
            run: () => auth.verifyIdToken('malformed'),
          },
          {
            name: 'createUser(invalid email)',
            expectedShortCode: 'invalid-email',
            run: () => auth.createUser({ uid: `${uid}-bad`, email: 'not-an-email' }),
          },
          {
            name: 'getUser(missing)',
            expectedShortCode: 'user-not-found',
            run: () => auth.getUser(`${uid}-missing`),
          },
          {
            name: 'getUserByEmail(missing)',
            expectedShortCode: 'user-not-found',
            run: () => auth.getUserByEmail(`${uid}-missing@example.com`),
          },
          {
            name: 'deleteUser(missing)',
            expectedShortCode: 'user-not-found',
            run: () => auth.deleteUser(`${uid}-missing`),
          },
          {
            name: 'setCustomUserClaims(reserved)',
            expectedShortCode: 'reserved-claim',
            run: () => auth.setCustomUserClaims(uid, { sub: 'override' }),
          },
          {
            name: 'setCustomUserClaims(too large)',
            expectedShortCode: 'claims-too-large',
            run: () => auth.setCustomUserClaims(uid, { blob: 'x'.repeat(1001) }),
          },
          {
            name: 'updateUser(missing)',
            expectedShortCode: 'user-not-found',
            run: () => auth.updateUser(`${uid}-missing`, { displayName: 'Missing' }),
          },
          {
            name: 'listUsers(0)',
            expectedShortCode: 'argument-error',
            run: () => auth.listUsers(0),
          },
          {
            name: 'revokeRefreshTokens(missing)',
            expectedShortCode: 'user-not-found',
            run: () => auth.revokeRefreshTokens(`${uid}-missing`),
          },
        ];
        for (const op of asyncFailureOps) {
          let caught: unknown;
          try {
            await op.run();
          } catch (err) {
            caught = err;
          }
          expect(
            caught instanceof FirebaseAuthError,
            `${label} ${op.name} rejection instanceof FirebaseAuthError`,
          ).toBe(true);
          if (caught instanceof FirebaseAuthError) {
            expect(caught.hasCode(op.expectedShortCode)).toBe(true);
          }
        }
      }

      let noDefaultAppErr: unknown;
      try {
        getAuth();
      } catch (err) {
        noDefaultAppErr = err;
      }
      expect(noDefaultAppErr instanceof Error).toBe(true);
      expect(noDefaultAppErr instanceof FirebaseAuthError).toBe(false);
      expect(noDefaultAppErr).toMatchObject({ code: 'app/no-app' });
    } finally {
      localSandbox.dispose();
      remoteStack.dispose();
    }
  });
});
