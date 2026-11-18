import { describe, expect, test } from 'bun:test';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { probe as credentialFactoriesProbe } from '../../probes/auth/auth-credential-factories-and-json-roundtrip.ts';
import { probe as emailCredAndProviderDataProbe } from '../../probes/auth/auth-email-credential-signin-and-providerdata.ts';
import { probe as providerClassesProbe } from '../../probes/auth/auth-provider-classes-and-saml-guard.ts';

const AUTH_PROVIDER_CREDENTIAL_PROBE_IDS = [
  'auth-credential-factories-and-json-roundtrip',
  'auth-email-credential-signin-and-providerdata',
  'auth-provider-classes-and-saml-guard',
] as const;

describe('Auth provider classes, credentials, and providerData linked probes (sdk-probes)', () => {
  test('registers all 3 Auth provider/credential probes with linked rowIds', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of AUTH_PROVIDER_CREDENTIAL_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    expect(providerClassesProbe.rig).toBe('sdk-probes');
    expect(providerClassesProbe.pendingRowLink).toBeUndefined();
    expect(providerClassesProbe.matrixRow).toBe('auth#50');
    expect(providerClassesProbe.rowIds).toEqual(['auth#50', 'auth#52', 'auth#181']);
    expect(providerClassesProbe.requires).toEqual([]);

    expect(credentialFactoriesProbe.rig).toBe('sdk-probes');
    expect(credentialFactoriesProbe.pendingRowLink).toBeUndefined();
    expect(credentialFactoriesProbe.matrixRow).toBe('auth#51');
    expect(credentialFactoriesProbe.rowIds).toEqual(['auth#51', 'auth#180', 'auth#181']);
    expect(credentialFactoriesProbe.requires).toEqual([]);

    expect(emailCredAndProviderDataProbe.rig).toBe('sdk-probes');
    expect(emailCredAndProviderDataProbe.pendingRowLink).toBeUndefined();
    expect(emailCredAndProviderDataProbe.matrixRow).toBe('auth#182');
    expect(emailCredAndProviderDataProbe.rowIds).toEqual(['auth#180', 'auth#182']);
    expect(emailCredAndProviderDataProbe.requires).toEqual(['web-config', 'admin-auth']);

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );
    for (const id of AUTH_PROVIDER_CREDENTIAL_PROBE_IDS) {
      expect(unfilteredIds.has(id)).toBe(true);
    }

    const lines: string[] = [];
    printModularProbePreview({
      rig: 'sdk-probes',
      scriptPath: 'packages/conformance/src/sdk-probes.ts',
      probes: loaded,
      log: (line) => lines.push(line),
    });
    expect(
      lines.some((line) => line.includes('auth-provider-classes-and-saml-guard')),
    ).toBe(true);
  });

  test('pure SDK provider and credential probes produce identical deterministic observations across runs', async () => {
    const providerRun1 = await providerClassesProbe.observe();
    const providerRun2 = await providerClassesProbe.observe();
    expect(providerRun1).toEqual(providerRun2);

    const credRun1 = await credentialFactoriesProbe.observe();
    const credRun2 = await credentialFactoriesProbe.observe();
    expect(credRun1).toEqual(credRun2);
  });
});
