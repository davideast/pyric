import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  observeCustomProviderWithoutDebugToken,
  probe as customProviderProbe,
} from '../../probes/app-check/app-check-custom-provider-without-debug-token.ts';
import {
  observeRecaptchaProvidersWithoutDocument,
  probe as recaptchaWithoutDocumentProbe,
} from '../../probes/app-check/app-check-recaptcha-providers-without-document.ts';
import {
  observeProjectFromCert,
  probe as projectFromCertProbe,
} from '../../probes/app-check-admin/app-check-admin-project-from-cert.ts';
import {
  observeVerifyTokenContentChecks,
  probe as verifyTokenContentChecksProbe,
} from '../../probes/app-check-admin/app-check-admin-verify-token-content-checks.ts';
import { resolvedAdminVersion, resolvedFirebaseVersion } from '../../src/package-version.ts';
import {
  executeModularProbes,
  loadModularProbes,
  SDK_PROBES_RIG_CONFIG,
} from '../../src/sdk-probes.ts';

const LINKED_APP_CHECK_PROBES = [
  'app-check-custom-provider-without-debug-token',
  'app-check-recaptcha-providers-without-document',
  'app-check-admin-verify-token-content-checks',
  'app-check-admin-project-from-cert',
] as const;

describe('linked app-check and app-check-admin sdk-probes', () => {
  it('registers all four probes under sdk-probes with linked rowIds and pendingRowLink dropped', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((item) => item.id);
    for (const id of LINKED_APP_CHECK_PROBES) {
      expect(loadedIds).toContain(id);
    }

    expect(customProviderProbe.pendingRowLink).toBeUndefined();
    expect(customProviderProbe.rowIds).toEqual(['app-check#custom-provider-without-debug-token']);
    expect(recaptchaWithoutDocumentProbe.pendingRowLink).toBeUndefined();
    expect(recaptchaWithoutDocumentProbe.rowIds).toEqual([
      'app-check#recaptcha-providers-without-document',
    ]);
    expect(verifyTokenContentChecksProbe.pendingRowLink).toBeUndefined();
    expect(verifyTokenContentChecksProbe.rowIds).toEqual([
      'app-check-admin#verify-token-content-checks',
    ]);
    expect(projectFromCertProbe.pendingRowLink).toBeUndefined();
    expect(projectFromCertProbe.rowIds).toEqual(['app-check-admin#project-from-cert']);

    for (const probe of [
      customProviderProbe,
      recaptchaWithoutDocumentProbe,
      verifyTokenContentChecksProbe,
      projectFromCertProbe,
    ]) {
      expect(probe.rig).toBe('sdk-probes');
      expect(probe.requires).toEqual(['web-config']);
    }
  });

  it('stamps both fbSdkVersion and adminSdkVersion when sdk-probes writes an *-admin observation', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pyric-app-check-sdk-probes-'));
    try {
      await executeModularProbes({
        config: SDK_PROBES_RIG_CONFIG,
        sdkVersion: resolvedFirebaseVersion(),
        projectId: 'demo-project',
        observationsRoot: tempDir,
        probes: [
          {
            id: 'app-check-admin-verify-token-content-checks',
            surfaceDir: 'app-check-admin',
            probe: verifyTokenContentChecksProbe,
          },
        ],
      });

      const written = JSON.parse(
        readFileSync(
          join(tempDir, 'app-check-admin', 'app-check-admin-verify-token-content-checks.json'),
          'utf8',
        ),
      ) as Record<string, unknown>;
      expect(written.fbSdkVersion).toBe(resolvedFirebaseVersion());
      expect(written.adminSdkVersion).toBe(resolvedAdminVersion());
      expect(written.rowIds).toEqual(['app-check-admin#verify-token-content-checks']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('observes real firebase/app-check CustomProvider caching, limited-use bypass, and error propagation', async () => {
    const behavior = await observeCustomProviderWithoutDebugToken();
    expect(behavior.customTokenCachingAndLimitedUse).toEqual({
      firstGetToken: { token: 'not-an-app-check-token' },
      secondGetToken: { token: 'not-an-app-check-token' },
      secondEqualsFirst: true,
      callsAfterFirstGetToken: 1,
      callsAfterSecondGetToken: 1,
      limitedUseToken: { token: 'not-an-app-check-token' },
      callsAfterLimitedUseToken: 2,
    });
    expect(behavior.providerRejection).toEqual({
      getTokenOutcome: {
        threw: true,
        sameErrorInstance: true,
        message: 'attestation failed',
      },
      getLimitedUseTokenOutcome: {
        threw: true,
        sameErrorInstance: true,
        message: 'attestation failed',
      },
      listenerEvents: [
        {
          kind: 'error',
          sameErrorInstance: true,
          message: 'attestation failed',
        },
      ],
      callsAfterBothRejections: 2,
    });
  });

  it('observes real firebase/app-check ReCaptchaV3Provider and ReCaptchaEnterpriseProvider without document', async () => {
    const behavior = await observeRecaptchaProvidersWithoutDocument();
    expect(behavior.hasGlobalDocument).toBe(false);
    for (const mode of [behavior.withoutDebugToken, behavior.withDebugTokenTrue]) {
      for (const outcome of [mode.recaptchaV3, mode.recaptchaEnterprise]) {
        expect(outcome.firstInitialize).toEqual({
          synchronousThrow: true,
          name: 'ReferenceError',
          code: null,
          message: 'document is not defined',
          customDataMatchesAppName: false,
        });
        expect(outcome.secondSameSiteKey).toEqual({
          synchronousThrow: false,
          returnsAppCheckForSameApp: true,
        });
        expect(outcome.thirdDifferentSiteKey).toEqual({
          synchronousThrow: true,
          name: 'FirebaseError',
          code: 'appCheck/already-initialized',
          message:
            'AppCheck: You have already called initializeAppCheck() for FirebaseApp <appName> with different options. To avoid this error, call initializeAppCheck() with the same options as when it was originally called. This will return the already initialized instance. (appCheck/already-initialized).',
          customDataMatchesAppName: true,
        });
      }
    }
    expect(await observeRecaptchaProvidersWithoutDocument()).toEqual(behavior);
  });

  it('observes real firebase-admin/app-check verifyToken pre-signature content checks and cert project precedence', async () => {
    const content = await observeVerifyTokenContentChecks();
    expect(content.optionsNull).toEqual({
      mode: 'sync-throw',
      code: 'app-check/invalid-argument',
      message: 'VerifyAppCheckTokenOptions must be a non-null object.',
    });
    expect(content.nonStringToken).toEqual({
      mode: 'sync-throw',
      code: 'app-check/invalid-argument',
      message: 'App check token must be a non-null string.',
    });
    expect(content.missingProjectId.mode).toBe('rejected');
    expect(content.missingProjectId.code).toBe('app-check/invalid-credential');
    expect(content.invalidBase64UrlSegment).toEqual({
      mode: 'rejected',
      code: 'app-check/invalid-argument',
      message:
        'Decoding App Check token failed. Make sure you passed the entire string JWT which represents the Firebase App Check token.',
    });
    expect(content.wrongAlgorithm).toEqual({
      mode: 'rejected',
      code: 'app-check/invalid-argument',
      message: 'The provided App Check token has incorrect algorithm. Expected "RS256" but got "HS256".',
    });
    expect(content.wrongAudience).toEqual({
      mode: 'rejected',
      code: 'app-check/invalid-argument',
      message:
        'The provided App Check token has incorrect "aud" (audience) claim. Expected "projects/another-project" but got "projects/123456789012,projects/demo-project". Make sure the App Check token comes from the same Firebase project as the service account used to authenticate this SDK.',
    });
    expect(content.wrongIssuer).toEqual({
      mode: 'rejected',
      code: 'app-check/invalid-argument',
      message: 'The provided App Check token has incorrect "iss" (issuer) claim.',
    });
    expect(content.missingSub).toEqual({
      mode: 'rejected',
      code: 'app-check/invalid-argument',
      message: 'The provided App Check token has no "sub" (subject) claim.',
    });
    expect(content.nonStringSub).toEqual({
      mode: 'rejected',
      code: 'app-check/invalid-argument',
      message: 'The provided App Check token has no "sub" (subject) claim.',
    });
    expect(content.emptySub).toEqual({
      mode: 'rejected',
      code: 'app-check/invalid-argument',
      message: 'The provided App Check token has an empty string "sub" (subject) claim.',
    });
    expect(await observeVerifyTokenContentChecks()).toEqual(content);

    const projectFromCert = await observeProjectFromCert();
    expect(projectFromCert).toEqual({
      snakeCaseCertOverEnv: {
        resolvedProjectId: 'demo-cert',
        appOptionsHasProjectIdKey: false,
        appOptionsProjectId: null,
      },
      camelCaseCertOverEnv: {
        resolvedProjectId: 'demo-camel',
        appOptionsHasProjectIdKey: false,
        appOptionsProjectId: null,
      },
      explicitOptionOverCert: {
        resolvedProjectId: 'demo-option',
        appOptionsHasProjectIdKey: true,
        appOptionsProjectId: 'demo-option',
      },
      googleCloudProjectOverGcloudProject: {
        resolvedProjectId: 'demo-env',
        appOptionsHasProjectIdKey: false,
        appOptionsProjectId: null,
      },
    });
    expect(await observeProjectFromCert()).toEqual(projectFromCert);
    expect(await observeCustomProviderWithoutDebugToken()).toEqual(
      await observeCustomProviderWithoutDebugToken(),
    );
  });
});
