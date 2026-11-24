import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import { rig as authGoogleOAuthRig } from '../../rigs/auth-google-oauth.ts';
import { loadRigManifests } from '../../rigs/load.ts';
import {
  extractRejectedEmail,
  extractResolvedEmail,
} from '../../src/capture/auth-google-oauth/app/main.ts';
import { startGoogleOAuthPopupBridge } from '../../src/capture/auth-google-oauth/browser-bridge.ts';
import { runInteractiveCaptureWithSignalCleanup } from '../../src/capture/auth-google-oauth/harness.ts';
import { AUTH_GOOGLE_OAUTH_OBSERVATION_NAME } from '../../src/capture/auth-google-oauth/observation-writer.ts';
import {
  runGoogleOAuthCollisionCapture,
  type GooglePopupDriver,
  type GooglePopupStepResult,
} from '../../src/capture/auth-google-oauth/session-runner.ts';
import { planCaptureRun } from '../../../../scripts/ci/oracle-capture-plan.ts';
import {
  createPrivateJobTmpDir,
  removePrivateJobTmpDir,
} from '../../../../scripts/lib/private-job-tmpdir.ts';
import { createFakeAuthEnvironment } from './auth-google-oauth-test-support.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');

describe('auth-google-oauth neutral capture & CI exclusion (#1814 Requirements 5-6)', () => {
  test('Requirement 5: records whatever production actually did for both @gmail.com and non-@gmail.com without baking expectations', async () => {
    const tmpDirA = createPrivateJobTmpDir('oauth-prA');
    const tmpDirB = createPrivateJobTmpDir('oauth-prB');
    try {
      // Profile A: @gmail.com overwrites unverified record (clears password, sets emailVerified=true);
      // non-@gmail.com rejects with auth/account-exists-with-different-credential and keeps password.
      const envA = createFakeAuthEnvironment();
      const popupA: GooglePopupDriver = {
        async runGooglePopup({ step, expectedEmail }): Promise<GooglePopupStepResult> {
          if (step === 'gmail') {
            const record = envA.usersByUid.get('run-created-uid-1');
            if (record) {
              record.password = null;
              record.emailVerified = true;
              record.providerIds = ['google.com'];
            }
            return {
              outcome: 'resolved',
              observedEmail: expectedEmail,
              resolvedUid: 'run-created-uid-1',
              userEmailVerified: true,
              userProviderIds: ['google.com'],
              tokenEmailVerifiedClaim: true,
              tokenSignInProvider: 'google.com',
              credentialFromResultPresent: true,
              sensitiveValues: ['Secret Display Name', 'oauth-access-token-xyz'],
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

      const outA = await runGoogleOAuthCollisionCapture({
        gmailEmail: 'throwaway@gmail.com',
        nonGmailEmail: 'throwaway@example.org',
        obsDir: tmpDirA,
        fbSdkVersion: '12.19.0',
        adminSdkVersion: '13.10.0',
        projectAllowDuplicateEmails: false,
        adminAuth: envA.adminAuth,
        passwordDriver: envA.passwordDriver,
        popupDriver: popupA,
        log: () => {},
      });

      expect(outA.observation.behavior.gmailUnverifiedAccountCollision.popupSucceeded).toBe(true);
      expect(
        outA.observation.behavior.gmailUnverifiedAccountCollision.postAttemptAdminHasPasswordHash,
      ).toBe(false);
      expect(
        outA.observation.behavior.gmailUnverifiedAccountCollision.postAttemptPasswordErrorCode,
      ).toBe('auth/invalid-credential');
      expect(outA.observation.behavior.nonGmailUnverifiedAccountCollision.popupSucceeded).toBe(
        false,
      );
      expect(outA.observation.behavior.nonGmailUnverifiedAccountCollision.popupErrorCode).toBe(
        'auth/account-exists-with-different-credential',
      );
      expect(
        outA.observation.behavior.nonGmailUnverifiedAccountCollision
          .postAttemptPasswordSignInSucceeded,
      ).toBe(true);

      const rawJsonA = readFileSync(outA.filePath, 'utf8');
      expect(rawJsonA).not.toContain('throwaway@gmail.com');
      expect(rawJsonA).not.toContain('throwaway@example.org');
      expect(rawJsonA).not.toContain('run-created-uid');
      expect(rawJsonA).not.toContain('Secret Display Name');
      expect(rawJsonA).not.toContain('googleusercontent');

      // Profile B (contrasting hypothetical production behavior): @gmail.com rejects with
      // auth/operation-not-allowed, while non-@gmail.com resolves with a distinct duplicate UID.
      const envB = createFakeAuthEnvironment();
      const popupB: GooglePopupDriver = {
        async runGooglePopup({ step, expectedEmail }): Promise<GooglePopupStepResult> {
          if (step === 'gmail') {
            return {
              outcome: 'rejected',
              observedEmail: expectedEmail,
              errorCode: 'auth/operation-not-allowed',
              credentialFromErrorPresent: false,
            };
          }
          envB.usersByUid.set('duplicate-google-uid-77', {
            uid: 'duplicate-google-uid-77',
            email: expectedEmail,
            password: null,
            emailVerified: true,
            providerIds: ['google.com'],
            customClaims: null,
            displayName: null,
            photoURL: null,
          });
          return {
            outcome: 'resolved',
            observedEmail: expectedEmail,
            resolvedUid: 'duplicate-google-uid-77',
            userEmailVerified: true,
            userProviderIds: ['google.com'],
            tokenEmailVerifiedClaim: true,
            tokenSignInProvider: 'google.com',
            credentialFromResultPresent: true,
          };
        },
      };

      const outB = await runGoogleOAuthCollisionCapture({
        gmailEmail: 'throwaway@gmail.com',
        nonGmailEmail: 'throwaway@example.org',
        obsDir: tmpDirB,
        fbSdkVersion: '12.19.0',
        adminSdkVersion: '13.10.0',
        projectAllowDuplicateEmails: true,
        adminAuth: envB.adminAuth,
        passwordDriver: envB.passwordDriver,
        popupDriver: popupB,
        log: () => {},
      });

      expect(outB.observation.behavior.projectAllowDuplicateEmails).toBe(true);
      expect(outB.observation.behavior.gmailUnverifiedAccountCollision.popupSucceeded).toBe(false);
      expect(outB.observation.behavior.gmailUnverifiedAccountCollision.popupErrorCode).toBe(
        'auth/operation-not-allowed',
      );
      expect(outB.observation.behavior.nonGmailUnverifiedAccountCollision.popupSucceeded).toBe(
        true,
      );
      expect(
        outB.observation.behavior.nonGmailUnverifiedAccountCollision.resolvedSameUidAsSeeded,
      ).toBe(false);
      expect(
        outB.observation.behavior.nonGmailUnverifiedAccountCollision
          .postAttemptPasswordSignInSucceeded,
      ).toBe(true);
      expect(envB.usersByUid.has('duplicate-google-uid-77')).toBe(false);
    } finally {
      removePrivateJobTmpDir(tmpDirA);
      removePrivateJobTmpDir(tmpDirB);
    }
  });

  test('Requirement 6: rig is human-witnessed, unreachable from push-triggered and manual CI capture workflows, and documented by runbook', async () => {
    const manifests = await loadRigManifests();
    const manifest = manifests.find((m) => m.id === 'auth-google-oauth');
    expect(manifest).toBeDefined();
    expect(manifest?.automation).toBe('human-witnessed');
    expect(manifest?.safety.unattendedSafe).toBe(false);
    expect(manifest?.observationPrefixes).toEqual([]);
    expect(manifest?.pendingPrefixes).toEqual(['auth-google-oauth-']);

    const ciEnv = {
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
      GCP_WIF_PROVIDER: 'projects/123/locations/global/workloadIdentityPools/p/providers/gh',
      PARITY_SA_EMAIL: 'parity@example.iam.gserviceaccount.com',
      CAPTURE_WIF_PROVIDER: 'projects/123/locations/global/workloadIdentityPools/p/providers/cap',
      CAPTURE_SA_EMAIL: 'capture@example.iam.gserviceaccount.com',
    };

    const pushPlan = await planCaptureRun(ciEnv, { stagedTargets: [] });
    expect(pushPlan.invocations.some((inv) => inv.rig === 'auth-google-oauth')).toBe(false);

    await expect(
      planCaptureRun({
        ...ciEnv,
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        INPUT_RIG: 'auth-google-oauth',
      }),
    ).rejects.toThrow(/human-witnessed/);

    const runbookPath = join(
      REPO_ROOT,
      'packages/conformance/docs/auth/google-oauth-capture-runbook.md',
    );
    expect(existsSync(runbookPath)).toBe(true);
    const runbook = readFileSync(runbookPath, 'utf8');
    expect(runbook).toContain('--gmail=');
    expect(runbook).toContain('--non-gmail=');
    expect(runbook).toContain('Sign-in method');
    expect(runbook).toContain('Step 1');
    expect(runbook).toContain('Step 2');
    expect(authGoogleOAuthRig.automation).toBe('human-witnessed');
  });

  test('loopback popup bridge bundles app/main.ts, enforces session token, and round-trips a popup step', async () => {
    const bridge = await startGoogleOAuthPopupBridge({
      webConfig: {
        apiKey: 'fake-api-key',
        authDomain: 'demo.firebaseapp.com',
        projectId: 'demo-project',
      },
      port: 0,
      openBrowser: false,
      log: () => {},
    });
    try {
      const htmlResp = await fetch(`${bridge.url}/`);
      expect(htmlResp.status).toBe(200);
      const htmlText = await htmlResp.text();
      expect(htmlText).toContain('Google OAuth Unverified-Account Capture');

      const jsResp = await fetch(`${bridge.url}/main.js`);
      expect(jsResp.status).toBe(200);
      const jsText = await jsResp.text();
      expect(jsText.length).toBeGreaterThan(100);

      const forbiddenResp = await fetch(`${bridge.url}/api/next-step`);
      expect(forbiddenResp.status).toBe(403);

      const tokenMatch = /"sessionToken":"([0-9a-f]{48})"/.exec(htmlText);
      const token = tokenMatch?.[1] ?? '';
      expect(token.length).toBe(48);

      const stepPromise = bridge.popupDriver.runGooglePopup({
        step: 'gmail',
        expectedEmail: 'throwaway@gmail.com',
      });

      const readyResp = await fetch(`${bridge.url}/api/next-step`, {
        headers: { 'x-pyric-oauth-token': token },
      });
      expect(await readyResp.json()).toEqual({
        state: 'ready',
        step: 'gmail',
        expectedEmail: 'throwaway@gmail.com',
      });

      const postResp = await fetch(`${bridge.url}/api/step-result`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pyric-oauth-token': token,
        },
        body: JSON.stringify({
          step: 'gmail',
          result: {
            outcome: 'rejected',
            observedEmail: 'throwaway@gmail.com',
            errorCode: 'auth/account-exists-with-different-credential',
            credentialFromErrorPresent: true,
          },
        }),
      });
      expect(postResp.status).toBe(200);
      expect(await stepPromise).toEqual({
        outcome: 'rejected',
        observedEmail: 'throwaway@gmail.com',
        errorCode: 'auth/account-exists-with-different-credential',
        credentialFromErrorPresent: true,
      });
    } finally {
      await bridge.close();
    }
  });

  test('SIGINT during interactive popup wait closes loopback bridge, deletes seeded user, and verifies getUser(uid) is gone', async () => {
    const tmpDir = createPrivateJobTmpDir('oauth-sig');
    const bridge = await startGoogleOAuthPopupBridge({
      webConfig: {
        apiKey: 'fake-api-key',
        authDomain: 'demo.firebaseapp.com',
        projectId: 'demo-project',
      },
      port: 0,
      openBrowser: false,
      log: () => {},
    });
    try {
      const env = createFakeAuthEnvironment();
      const signals = new EventEmitter();
      const recordedExitCodes: number[] = [];

      const htmlText = await (await fetch(`${bridge.url}/`)).text();
      const tokenMatch = /"sessionToken":"([0-9a-f]{48})"/.exec(htmlText);
      const token = tokenMatch?.[1] ?? '';
      expect(token.length).toBe(48);

      const sessionPromise = runInteractiveCaptureWithSignalCleanup({
        bridge,
        signalTarget: signals,
        setExitCode: (code) => {
          recordedExitCodes.push(code);
        },
        postFinishDelayMs: 0,
        runCapture: () =>
          runGoogleOAuthCollisionCapture({
            gmailEmail: 'throwaway@gmail.com',
            nonGmailEmail: 'throwaway@example.org',
            obsDir: tmpDir,
            fbSdkVersion: '12.19.0',
            adminSdkVersion: '13.10.0',
            projectAllowDuplicateEmails: false,
            adminAuth: env.adminAuth,
            passwordDriver: env.passwordDriver,
            popupDriver: bridge.popupDriver,
            log: () => {},
          }),
      });

      for (;;) {
        const pollResp = await fetch(`${bridge.url}/api/next-step`, {
          headers: { 'x-pyric-oauth-token': token },
        });
        const pollBody = (await pollResp.json()) as { state?: string };
        if (pollBody.state === 'ready') {
          break;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }

      expect(env.usersByUid.has('run-created-uid-1')).toBe(true);
      signals.emit('SIGINT');

      await expect(sessionPromise).rejects.toThrow(/Popup bridge closed before step completed/);
      expect(recordedExitCodes).toEqual([130]);
      expect(env.deletedUids).toEqual(['run-created-uid-1']);
      expect(env.usersByUid.size).toBe(0);
      expect(existsSync(join(tmpDir, `${AUTH_GOOGLE_OAUTH_OBSERVATION_NAME}.json`))).toBe(false);
      expect(signals.listenerCount('SIGINT')).toBe(0);
      expect(signals.listenerCount('SIGTERM')).toBe(0);
    } finally {
      await bridge.close();
      removePrivateJobTmpDir(tmpDir);
    }
  });

  test('browser popup email extractors handle customData, _tokenResponse, and JWT payload fallbacks', () => {
    const fakePayload = Buffer.from(JSON.stringify({ email: 'jwt-fallback@example.org' }))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
    const fakeJwt = `eyJhbGciOiJub25lIn0.${fakePayload}.c2ln`;

    expect(extractResolvedEmail('direct@gmail.com', [], null, null)).toBe('direct@gmail.com');
    expect(extractResolvedEmail(null, [null, 'provider@gmail.com'], null, null)).toBe(
      'provider@gmail.com',
    );
    expect(extractResolvedEmail(null, [], 'profile@example.org', null)).toBe('profile@example.org');
    expect(extractResolvedEmail(null, [], null, fakeJwt)).toBe('jwt-fallback@example.org');

    expect(
      extractRejectedEmail({
        code: 'auth/account-exists-with-different-credential',
        customData: { email: 'collision@example.org' },
      }),
    ).toEqual({
      email: 'collision@example.org',
      errorCode: 'auth/account-exists-with-different-credential',
      credentialPresent: false,
    });

    expect(
      extractRejectedEmail({
        code: 'auth/account-exists-with-different-credential',
        customData: { _tokenResponse: { email: 'token-resp@example.org' } },
      }),
    ).toEqual({
      email: 'token-resp@example.org',
      errorCode: 'auth/account-exists-with-different-credential',
      credentialPresent: false,
    });
  });
});
