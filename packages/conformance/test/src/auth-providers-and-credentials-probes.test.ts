import { describe, expect, test } from 'bun:test';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';
import { probe as credentialFactoriesProbe } from '../../probes/auth/auth-credential-factories-and-json-roundtrip.ts';
import { probe as emailCredAndProviderDataProbe } from '../../probes/auth/auth-email-credential-signin-and-providerdata.ts';
import { probe as providerClassesProbe } from '../../probes/auth/auth-provider-classes-and-saml-guard.ts';

const AUTH_PROVIDER_CREDENTIAL_PROBE_IDS = [
  'auth-credential-factories-and-json-roundtrip',
  'auth-email-credential-signin-and-providerdata',
  'auth-provider-classes-and-saml-guard',
] as const;

describe('Auth provider classes, credentials, and providerData staged probes (sdk-probes)', () => {
  test('registers all 3 Auth provider/credential probes with pendingRowLink and empty rowIds', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of AUTH_PROVIDER_CREDENTIAL_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    const probes = [
      providerClassesProbe,
      credentialFactoriesProbe,
      emailCredAndProviderDataProbe,
    ];
    for (const probeRecord of probes) {
      expect(probeRecord.rig).toBe('sdk-probes');
      expect(probeRecord.pendingRowLink).toBe(true);
      expect(probeRecord.matrixRow).toBe('');
      expect(probeRecord.rowIds).toEqual([]);
      expect(probeRecord.description.length).toBeGreaterThan(20);
    }
    expect(providerClassesProbe.requires).toEqual([]);
    expect(credentialFactoriesProbe.requires).toEqual([]);
    expect(emailCredAndProviderDataProbe.requires).toEqual(['web-config', 'admin-auth']);

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );

    expectStagedUntilCaptured(AUTH_PROVIDER_CREDENTIAL_PROBE_IDS, {
      rig: 'sdk-probes',
      filterFlag: '--probe',
      filterValueFor: (name) => name,
      whenUncaptured(name) {
        expect(unfilteredIds.has(name)).toBe(false);
      },
      whenCaptured(name) {
        expect(unfilteredIds.has(name)).toBe(true);
      },
    });

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
