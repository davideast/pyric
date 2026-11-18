import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getAuth as getClientAuth,
  inMemoryPersistence,
  setPersistence,
  signInWithCustomToken,
} from 'pyric/auth';
import { deleteApp, initializeApp } from '../../../pyric-admin/src/app/index.js';
import { getAuth } from '../../../pyric-admin/src/auth/index.js';
import {
  observeGetAuthAppLifecycle,
  probe as getAuthLifecycleProbe,
} from '../../probes/auth-admin/admin-auth-getauth-app-lifecycle.ts';
import {
  observeRevokeRefreshTokens,
  probe as revokeRefreshTokensProbe,
  type RevokeRefreshTokensSubject,
} from '../../probes/auth-admin/admin-auth-revoke-refresh-tokens.ts';
import {
  type AdminUpdateUserSubject,
  observeUpdateUserFields,
  probe as updateUserFieldsProbe,
} from '../../probes/auth-admin/admin-auth-update-user-fields.ts';
import {
  observeLocalVerifyIdTokenPreSignatureChecks,
  probe as verifyIdTokenErrorsProbe,
  rewriteJwtClaim,
  scrubVerifyIdTokenMessage,
  tamperJwtSignature,
} from '../../probes/auth-admin/admin-auth-verify-id-token-errors.ts';
import { loadModularProbes } from '../../src/sdk-probes.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';

const STAGED_ADMIN_AUTH_PROBES = [
  'admin-auth-getauth-app-lifecycle',
  'admin-auth-verify-id-token-errors',
  'admin-auth-revoke-refresh-tokens',
  'admin-auth-update-user-fields',
] as const;

describe('staged auth-admin probes', () => {
  it('registers all four probes under admin-auth and tracks staged discovery via expectStagedUntilCaptured', async () => {
    const loaded = await loadModularProbes('admin-auth');
    const loadedIds = loaded.map((item) => item.id);
    for (const id of STAGED_ADMIN_AUTH_PROBES) {
      expect(loadedIds).toContain(id);
    }

    expect(getAuthLifecycleProbe.rig).toBe('admin-auth');
    expect(getAuthLifecycleProbe.requires).toEqual(['admin-auth']);
    expect(verifyIdTokenErrorsProbe.rig).toBe('admin-auth');
    expect(verifyIdTokenErrorsProbe.requires).toEqual(['admin-auth', 'web-config']);
    expect(revokeRefreshTokensProbe.rig).toBe('admin-auth');
    expect(revokeRefreshTokensProbe.requires).toEqual(['admin-auth', 'web-config']);
    expect(updateUserFieldsProbe.rig).toBe('admin-auth');
    expect(updateUserFieldsProbe.requires).toEqual(['admin-auth']);

    expectStagedUntilCaptured(STAGED_ADMIN_AUTH_PROBES, {
      rig: 'admin-auth',
      filterFlag: '--probe',
      filterValueFor: (name) => name,
    });
  });

  it('observes real firebase-admin/auth getAuth(app) caching, cross-app isolation, and deleted-app throw', async () => {
    const first = await observeGetAuthAppLifecycle();
    expect(first).toEqual({
      authAppMatchesExplicitApp: true,
      cachedSameAppHandle: true,
      distinctHandlesAcrossApps: true,
      getAuthAfterDeleteApp: {
        mode: 'sync-throw',
        code: 'app/app-deleted',
        message: 'Firebase app named "<appName>" has already been deleted.',
      },
    });
    expect(await observeGetAuthAppLifecycle()).toEqual(first);
  });

  it('observes real firebase-admin/auth pre-signature verifyIdToken checks and scrubs projectId from messages', async () => {
    const first = await observeLocalVerifyIdTokenPreSignatureChecks('secret-oracle-proj');
    expect(first.nonStringToken.mode).toBe('sync-throw');
    expect(first.nonStringToken.code).toBe('auth/argument-error');
    expect(first.emptyStringToken.code).toBe('auth/argument-error');
    expect(first.malformedJwt.code).toBe('auth/argument-error');
    expect(first.missingKidJwt.code).toBe('auth/argument-error');
    expect(first.wrongAlgorithmJwt.code).toBe('auth/argument-error');
    expect(JSON.stringify(first)).not.toContain('secret-oracle-proj');
    expect(await observeLocalVerifyIdTokenPreSignatureChecks('secret-oracle-proj')).toEqual(first);

    expect(
      scrubVerifyIdTokenMessage(
        'Expected "secret-oracle-proj" but got "other".',
        'secret-oracle-proj',
      ),
    ).toBe('Expected "<projectId>" but got "other".');

    const sampleToken =
      `${Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url')}.` +
      `${Buffer.from(JSON.stringify({ iss: 'old' })).toString('base64url')}.sigAA`;
    const rewritten = rewriteJwtClaim(sampleToken, 'iss', 'new-iss');
    const secondPart = rewritten.split('.')[1] ?? '';
    const decodedPayload = JSON.parse(
      Buffer.from(secondPart, 'base64url').toString('utf8'),
    ) as { iss?: string };
    expect(decodedPayload.iss).toBe('new-iss');
    expect(tamperJwtSignature(sampleToken).endsWith('sigBB')).toBe(true);
  });

  it('exercises observeRevokeRefreshTokens and observeUpdateUserFields end-to-end against pyric-admin/auth', async () => {
    const sandbox = initializeSandbox();
    const app = initializeApp({ sandbox }, 'test-admin-auth-probes');
    const adminAuth = getAuth(app);

    try {
      const revokeSubject: RevokeRefreshTokensSubject = {
        async createUser(uid: string): Promise<void> {
          await adminAuth.createUser({ uid });
        },
        async createCustomToken(uid: string): Promise<string> {
          return adminAuth.createCustomToken(uid);
        },
        async getUser(uid: string): Promise<{ tokensValidAfterTime?: string }> {
          const user = await adminAuth.getUser(uid);
          return { tokensValidAfterTime: user.tokensValidAfterTime };
        },
        async revokeRefreshTokens(uid: string): Promise<unknown> {
          return adminAuth.revokeRefreshTokens(uid);
        },
        async verifyIdToken(idToken: string, checkRevoked?: boolean) {
          return adminAuth.verifyIdToken(idToken, checkRevoked);
        },
        async signInClientWithCustomToken(customToken: string) {
          const clientAuth = getClientAuth(sandbox);
          await setPersistence(clientAuth, inMemoryPersistence);
          const cred = await signInWithCustomToken(clientAuth, customToken);
          return {
            async getIdToken(forceRefresh = false): Promise<string> {
              return cred.user.getIdToken(forceRefresh);
            },
            async dispose(): Promise<void> {},
          };
        },
        async waitForNextUtcSecondAfter(authTimeSec: number): Promise<void> {
          while (Math.floor(Date.now() / 1000) <= authTimeSec) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        },
      };

      const revokeObserved = await observeRevokeRefreshTokens(revokeSubject, 'unit-prefix');
      expect(revokeObserved).toEqual({
        returnsUndefined: true,
        tokensValidAfterTimeIsString: true,
        validSinceStrictlyAfterPriorAuthTime: true,
        verifyOmittedCheckRevoked: { threw: false, code: null, uidMatches: true },
        verifyFalseCheckRevoked: { threw: false, code: null, uidMatches: true },
        verifyTrueCheckRevokedPriorToken: { threw: true, code: 'auth/id-token-revoked' },
        clientForceRefreshAfterRevoke: { threw: true, code: 'auth/user-token-expired' },
        verifyTrueCheckRevokedFreshToken: { threw: false, code: null, uidMatches: true },
        revokeMissingUser: { threw: true, code: 'auth/user-not-found' },
      });

      const records = new Map<
        string,
        {
          uid: string;
          email: string;
          emailVerified: boolean;
          displayName?: string;
          photoURL?: string;
          phoneNumber?: string;
          disabled: boolean;
          providerData: Array<{ providerId: string }>;
        }
      >();
      const updateSubject: AdminUpdateUserSubject = {
        async createUser(props) {
          const entry = {
            uid: props.uid,
            email: props.email,
            emailVerified: false,
            disabled: false,
            providerData: [{ providerId: 'password' }],
          };
          records.set(props.uid, entry);
          return entry as unknown as Awaited<ReturnType<AdminUpdateUserSubject['createUser']>>;
        },
        async updateUser(uid, props) {
          const existing = records.get(uid);
          if (!existing) {
            throw Object.assign(new Error('No user record'), { code: 'auth/user-not-found' });
          }
          if (typeof props.email === 'string') existing.email = props.email;
          if (typeof props.emailVerified === 'boolean') existing.emailVerified = props.emailVerified;
          if (props.displayName === null) delete existing.displayName;
          if (typeof props.displayName === 'string') existing.displayName = props.displayName;
          if (props.photoURL === null) delete existing.photoURL;
          if (typeof props.photoURL === 'string') existing.photoURL = props.photoURL;
          if (props.phoneNumber === null) {
            delete existing.phoneNumber;
            existing.providerData = existing.providerData.filter((p) => p.providerId !== 'phone');
          }
          if (typeof props.phoneNumber === 'string') {
            existing.phoneNumber = props.phoneNumber;
            if (!existing.providerData.some((p) => p.providerId === 'phone')) {
              existing.providerData.push({ providerId: 'phone' });
            }
          }
          if (typeof props.disabled === 'boolean') existing.disabled = props.disabled;
          return { ...existing, providerData: [...existing.providerData] } as unknown as Awaited<
            ReturnType<AdminUpdateUserSubject['updateUser']>
          >;
        },
        async getUser(uid) {
          const existing = records.get(uid);
          if (!existing) {
            throw Object.assign(new Error('No user record'), { code: 'auth/user-not-found' });
          }
          return { ...existing, providerData: [...existing.providerData] } as unknown as Awaited<
            ReturnType<AdminUpdateUserSubject['getUser']>
          >;
        },
      };
      const updateObserved = await observeUpdateUserFields(updateSubject, 'unit-update');
      expect(updateObserved.missingUserError).toEqual({
        threw: true,
        code: 'auth/user-not-found',
      });
      expect(updateObserved.updatedFetched).toEqual({
        emailMatchesExpected: true,
        emailVerified: true,
        displayName: 'Updated Name',
        photoURL: 'https://example.com/avatar.png',
        phoneNumberMatchesExpected: true,
        disabled: true,
        providerIds: ['password', 'phone'],
      });
      expect(updateObserved.clearedFetched).toEqual({
        emailMatchesExpected: true,
        emailVerified: true,
        displayName: null,
        photoURL: null,
        phoneNumberMatchesExpected: true,
        disabled: false,
        providerIds: ['password'],
      });
    } finally {
      await deleteApp(app);
      sandbox.dispose();
    }
  });
});
