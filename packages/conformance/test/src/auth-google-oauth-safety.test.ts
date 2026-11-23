import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  missingExplicitEmailFlags,
  parseAuthGoogleOAuthCliArgs,
} from '../../src/capture/auth-google-oauth/cli-args.ts';
import {
  AUTH_GOOGLE_OAUTH_OBSERVATION_NAME,
  assertNoSensitiveFieldsInObservation,
  writeAuthGoogleOAuthObservation,
  type AuthGoogleOAuthBehavior,
} from '../../src/capture/auth-google-oauth/observation-writer.ts';
import {
  GOOGLE_OAUTH_TEST_MARKER_CLAIM,
  runGoogleOAuthCollisionCapture,
  type GooglePopupDriver,
} from '../../src/capture/auth-google-oauth/session-runner.ts';
import {
  createPrivateJobTmpDir,
  removePrivateJobTmpDir,
} from '../../../../scripts/lib/private-job-tmpdir.ts';
import { createFakeAuthEnvironment, sampleCaseBehavior } from './auth-google-oauth-test-support.ts';

describe('auth-google-oauth safety & PII guards (#1814 Requirements 1-4)', () => {
  test('Requirement 1: refuses to start unless both --gmail and --non-gmail are passed explicitly and valid', () => {
    expect(missingExplicitEmailFlags([])).toContain('--gmail=');
    expect(missingExplicitEmailFlags(['--gmail=throwaway@gmail.com'])).toContain('--non-gmail=');
    expect(missingExplicitEmailFlags(['--non-gmail=throwaway@example.org'])).toContain('--gmail=');
    expect(
      missingExplicitEmailFlags([
        '--gmail=throwaway@gmail.com',
        '--non-gmail=throwaway@example.org',
      ]),
    ).toBeNull();

    expect(() => parseAuthGoogleOAuthCliArgs([])).toThrow(/--gmail/);
    expect(() => parseAuthGoogleOAuthCliArgs(['--gmail=throwaway@gmail.com'])).toThrow(
      /--non-gmail/,
    );
    expect(() =>
      parseAuthGoogleOAuthCliArgs([
        '--gmail=not-gmail@example.org',
        '--non-gmail=throwaway@example.org',
      ]),
    ).toThrow(/expected a valid @gmail\.com/);
    expect(() =>
      parseAuthGoogleOAuthCliArgs([
        '--gmail=throwaway@gmail.com',
        '--non-gmail=second@gmail.com',
      ]),
    ).toThrow(/non-@gmail\.com/);
    expect(() =>
      parseAuthGoogleOAuthCliArgs([
        '--gmail=throwaway@gmail.com',
        '--non-gmail=second@googlemail.com',
      ]),
    ).toThrow(/non-@gmail\.com/);

    const parsed = parseAuthGoogleOAuthCliArgs([
      '--gmail',
      '  Throwaway.Test@Gmail.com ',
      '--non-gmail=Oracle.User@Example.org',
      '--port=4912',
      '--no-open',
    ]);
    expect(parsed).toEqual({
      gmailEmail: 'throwaway.test@gmail.com',
      nonGmailEmail: 'oracle.user@example.org',
      port: 4912,
      openBrowser: false,
    });
  });

  test('Requirement 1: pre-flight aborts if either email already exists without marker claim and never modifies or deletes unmarked users', async () => {
    const tmpDir = createPrivateJobTmpDir('oauth-pre');
    try {
      for (const existingEmail of ['throwaway@gmail.com', 'throwaway@example.org']) {
        const env = createFakeAuthEnvironment({
          initialUsers: [
            {
              uid: 'real-unmarked-uid-99',
              email: existingEmail,
              password: 'existing-secret-password',
              emailVerified: true,
              providerIds: ['password'],
              customClaims: null,
              displayName: 'Real Unmarked Account',
              photoURL: null,
            },
          ],
        });

        let popupCalled = false;
        const popupDriver: GooglePopupDriver = {
          async runGooglePopup() {
            popupCalled = true;
            throw new Error('should never reach popup');
          },
        };

        await expect(
          runGoogleOAuthCollisionCapture({
            gmailEmail: 'throwaway@gmail.com',
            nonGmailEmail: 'throwaway@example.org',
            obsDir: tmpDir,
            fbSdkVersion: '12.19.0',
            adminSdkVersion: '13.10.0',
            projectAllowDuplicateEmails: false,
            adminAuth: env.adminAuth,
            passwordDriver: env.passwordDriver,
            popupDriver,
            log: () => {},
          }),
        ).rejects.toThrow(/Pre-flight aborted/);

        expect(popupCalled).toBe(false);
        expect(env.deletedUids).toEqual([]);
        expect(env.modifiedUids).toEqual([]);
        expect(env.usersByUid.get('real-unmarked-uid-99')?.password).toBe(
          'existing-secret-password',
        );
        expect(existsSync(join(tmpDir, `${AUTH_GOOGLE_OAUTH_OBSERVATION_NAME}.json`))).toBe(false);
      }
    } finally {
      removePrivateJobTmpDir(tmpDir);
    }
  });

  test('Requirement 2: aborts on signed-in email mismatch (resolved or rejected), cleans up only run-created users, and never touches mismatched user', async () => {
    const tmpDir = createPrivateJobTmpDir('oauth-mis');
    try {
      const envResolvedMismatch = createFakeAuthEnvironment({
        initialUsers: [
          {
            uid: 'bystander-real-uid',
            email: 'wrong@gmail.com',
            password: 'keep-me',
            emailVerified: true,
            providerIds: ['google.com'],
            customClaims: null,
            displayName: 'Bystander',
            photoURL: null,
          },
        ],
      });

      const resolvedMismatchPopup: GooglePopupDriver = {
        async runGooglePopup() {
          return {
            outcome: 'resolved',
            observedEmail: 'wrong@gmail.com',
            resolvedUid: 'bystander-real-uid',
            userEmailVerified: true,
            userProviderIds: ['google.com'],
            tokenEmailVerifiedClaim: true,
            tokenSignInProvider: 'google.com',
            credentialFromResultPresent: true,
          };
        },
      };

      await expect(
        runGoogleOAuthCollisionCapture({
          gmailEmail: 'throwaway@gmail.com',
          nonGmailEmail: 'throwaway@example.org',
          obsDir: tmpDir,
          fbSdkVersion: '12.19.0',
          adminSdkVersion: '13.10.0',
          projectAllowDuplicateEmails: false,
          adminAuth: envResolvedMismatch.adminAuth,
          passwordDriver: envResolvedMismatch.passwordDriver,
          popupDriver: resolvedMismatchPopup,
          log: () => {},
        }),
      ).rejects.toThrow(/Account email mismatch on gmail popup/);

      expect(envResolvedMismatch.deletedUids).toEqual(['run-created-uid-1']);
      expect(envResolvedMismatch.usersByUid.has('run-created-uid-1')).toBe(false);
      expect(envResolvedMismatch.usersByUid.has('bystander-real-uid')).toBe(true);
      expect(existsSync(join(tmpDir, `${AUTH_GOOGLE_OAUTH_OBSERVATION_NAME}.json`))).toBe(false);

      const envRejectedMismatch = createFakeAuthEnvironment({
        initialUsers: [
          {
            uid: 'bystander-corp-uid',
            email: 'other@example.org',
            password: 'corp-password',
            emailVerified: false,
            providerIds: ['password'],
            customClaims: null,
            displayName: 'Corp Bystander',
            photoURL: null,
          },
        ],
      });

      const rejectedMismatchPopup: GooglePopupDriver = {
        async runGooglePopup({ step, expectedEmail }) {
          if (step === 'gmail') {
            return {
              outcome: 'resolved',
              observedEmail: expectedEmail,
              resolvedUid: 'run-created-uid-1',
              userEmailVerified: true,
              userProviderIds: ['google.com'],
              tokenEmailVerifiedClaim: true,
              tokenSignInProvider: 'google.com',
              credentialFromResultPresent: true,
            };
          }
          return {
            outcome: 'rejected',
            observedEmail: 'other@example.org',
            errorCode: 'auth/account-exists-with-different-credential',
            credentialFromErrorPresent: true,
          };
        },
      };

      await expect(
        runGoogleOAuthCollisionCapture({
          gmailEmail: 'throwaway@gmail.com',
          nonGmailEmail: 'throwaway@example.org',
          obsDir: tmpDir,
          fbSdkVersion: '12.19.0',
          adminSdkVersion: '13.10.0',
          projectAllowDuplicateEmails: false,
          adminAuth: envRejectedMismatch.adminAuth,
          passwordDriver: envRejectedMismatch.passwordDriver,
          popupDriver: rejectedMismatchPopup,
          log: () => {},
        }),
      ).rejects.toThrow(/Account email mismatch on non-gmail popup/);

      expect(envRejectedMismatch.deletedUids).toEqual(['run-created-uid-1', 'run-created-uid-2']);
      expect(envRejectedMismatch.usersByUid.has('bystander-corp-uid')).toBe(true);
      expect(existsSync(join(tmpDir, `${AUTH_GOOGLE_OAUTH_OBSERVATION_NAME}.json`))).toBe(false);
    } finally {
      removePrivateJobTmpDir(tmpDir);
    }
  });

  test('Requirement 3: observation writer rejects any email, UID, display name, photo URL, project ID, or token in the output', () => {
    const cleanBehavior: AuthGoogleOAuthBehavior = {
      projectAllowDuplicateEmails: false,
      gmailUnverifiedAccountCollision: sampleCaseBehavior(),
      nonGmailUnverifiedAccountCollision: {
        ...sampleCaseBehavior(),
        popupSucceeded: false,
        popupErrorCode: 'auth/account-exists-with-different-credential',
        credentialFromResultPresent: false,
        credentialFromErrorPresent: true,
        resolvedSameUidAsSeeded: null,
        resolvedUserEmailVerified: null,
        resolvedUserProviderIds: null,
        resolvedTokenEmailVerifiedClaim: null,
        resolvedTokenSignInProvider: null,
        postAttemptAdminEmailVerified: false,
        postAttemptAdminHasPasswordHash: true,
        postAttemptAdminProviderIds: ['password'],
        postAttemptPasswordSignInSucceeded: true,
        postAttemptPasswordErrorCode: null,
      },
    };

    const validEnvelope = {
      name: AUTH_GOOGLE_OAUTH_OBSERVATION_NAME,
      matrixRow: '',
      rowIds: [],
      description: 'Sanitized capture.',
      observedAt: '2026-11-23T00:00:00.000Z',
      fbSdkVersion: '12.19.0',
      adminSdkVersion: '13.10.0',
      behavior: cleanBehavior,
    };

    expect(() =>
      assertNoSensitiveFieldsInObservation(validEnvelope, [
        'throwaway@gmail.com',
        'throwaway@example.org',
        'uid-secret-12345',
        'Ada Lovelace',
        'https://lh3.googleusercontent.com/a/photo',
        'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl',
      ]),
    ).not.toThrow();

    for (const forbiddenKey of [
      'email',
      'uid',
      'displayName',
      'photoURL',
      'idToken',
      'accessToken',
      'refreshToken',
      'projectId',
    ]) {
      expect(() =>
        assertNoSensitiveFieldsInObservation({
          ...validEnvelope,
          behavior: { ...cleanBehavior, [forbiddenKey]: true },
        }),
      ).toThrow(/forbidden key/);
    }

    expect(() =>
      assertNoSensitiveFieldsInObservation({ ...validEnvelope, projectId: 'my-firebase-project' }),
    ).toThrow(/unexpected top-level key 'projectId'/);

    for (const badValue of [
      'user@gmail.com',
      'https://lh3.googleusercontent.com/a/avatar.png',
      'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6InRlc3RAZ21haWwuY29tIn0.c2lnbmF0dXJl',
      'Ada Lovelace',
      'f8Kp9LmN2QrStUvWxYz12345678',
    ]) {
      expect(() =>
        assertNoSensitiveFieldsInObservation(
          {
            ...validEnvelope,
            behavior: {
              ...cleanBehavior,
              gmailUnverifiedAccountCollision: {
                ...cleanBehavior.gmailUnverifiedAccountCollision,
                popupErrorCode: badValue,
              },
            },
          },
          ['Ada Lovelace'],
        ),
      ).toThrow();
    }

    const tmpDir = createPrivateJobTmpDir('oauth-obs');
    try {
      expect(() =>
        writeAuthGoogleOAuthObservation({
          obsDir: tmpDir,
          fbSdkVersion: '12.19.0',
          adminSdkVersion: '13.10.0',
          behavior: {
            ...cleanBehavior,
            gmailUnverifiedAccountCollision: {
              ...cleanBehavior.gmailUnverifiedAccountCollision,
              popupErrorCode: 'leak@gmail.com',
            },
          },
        }),
      ).toThrow();
      expect(existsSync(join(tmpDir, `${AUTH_GOOGLE_OAUTH_OBSERVATION_NAME}.json`))).toBe(false);
    } finally {
      removePrivateJobTmpDir(tmpDir);
    }
  });

  test('Requirement 4: startup sweep removes only marker-claimed orphans and finally verifies deletion', async () => {
    const tmpDir = createPrivateJobTmpDir('oauth-swp');
    try {
      const env = createFakeAuthEnvironment({
        initialUsers: [
          {
            uid: 'orphan-marked-1',
            email: 'throwaway@gmail.com',
            password: 'old',
            emailVerified: false,
            providerIds: ['password'],
            customClaims: { [GOOGLE_OAUTH_TEST_MARKER_CLAIM]: true },
            displayName: null,
            photoURL: null,
          },
          {
            uid: 'orphan-marked-2',
            email: 'stale@other.example',
            password: 'old',
            emailVerified: false,
            providerIds: ['password'],
            customClaims: { [GOOGLE_OAUTH_TEST_MARKER_CLAIM]: true },
            displayName: null,
            photoURL: null,
          },
          {
            uid: 'permanent-unmarked-user',
            email: 'keep@unrelated.example',
            password: 'keep',
            emailVerified: true,
            providerIds: ['password'],
            customClaims: { role: 'reader' },
            displayName: 'Keep Me',
            photoURL: null,
          },
        ],
      });

      const popupDriver: GooglePopupDriver = {
        async runGooglePopup({ step, expectedEmail }) {
          if (step === 'gmail') {
            return {
              outcome: 'resolved',
              observedEmail: expectedEmail,
              resolvedUid: 'run-created-uid-1',
              userEmailVerified: true,
              userProviderIds: ['google.com'],
              tokenEmailVerifiedClaim: true,
              tokenSignInProvider: 'google.com',
              credentialFromResultPresent: true,
            };
          }
          return {
            outcome: 'rejected',
            observedEmail: expectedEmail,
            errorCode: 'auth/account-exists-with-different-credential',
            credentialFromErrorPresent: true,
          };
        },
      };

      const res = await runGoogleOAuthCollisionCapture({
        gmailEmail: 'throwaway@gmail.com',
        nonGmailEmail: 'throwaway@example.org',
        obsDir: tmpDir,
        fbSdkVersion: '12.19.0',
        adminSdkVersion: '13.10.0',
        projectAllowDuplicateEmails: false,
        adminAuth: env.adminAuth,
        passwordDriver: env.passwordDriver,
        popupDriver,
        log: () => {},
      });

      expect(res.sweptOrphanCount).toBe(2);
      expect(env.usersByUid.has('orphan-marked-1')).toBe(false);
      expect(env.usersByUid.has('orphan-marked-2')).toBe(false);
      expect(env.usersByUid.has('run-created-uid-1')).toBe(false);
      expect(env.usersByUid.has('run-created-uid-2')).toBe(false);
      expect(env.usersByUid.has('permanent-unmarked-user')).toBe(true);

      const brokenCleanupEnv = createFakeAuthEnvironment({
        failCleanupVerificationForUid: 'run-created-uid-1',
      });
      await expect(
        runGoogleOAuthCollisionCapture({
          gmailEmail: 'throwaway@gmail.com',
          nonGmailEmail: 'throwaway@example.org',
          obsDir: tmpDir,
          fbSdkVersion: '12.19.0',
          adminSdkVersion: '13.10.0',
          projectAllowDuplicateEmails: false,
          adminAuth: brokenCleanupEnv.adminAuth,
          passwordDriver: brokenCleanupEnv.passwordDriver,
          popupDriver,
          log: () => {},
        }),
      ).rejects.toThrow(/Cleanup verification failed/);
    } finally {
      removePrivateJobTmpDir(tmpDir);
    }
  });
});
