import { describe, expect, test } from 'bun:test';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';
import { probe as anonIdempotencyProbe } from '../../probes/auth/auth-anonymous-idempotency-and-remint.ts';
import { probe as canonicalAndCreateProbe } from '../../probes/auth/auth-canonical-import-and-createuser-shape.ts';
import { probe as credSignInRichAndDisabledProbe } from '../../probes/auth/auth-credential-signin-rich-user-and-disabled-guard.ts';
import { probe as tokenExpiryBufferProbe } from '../../probes/auth/auth-getidtoken-expiry-buffer-refresh.ts';

const AUTH_ANON_CREATE_CRED_EXPIRY_PROBE_IDS = [
  'auth-anonymous-idempotency-and-remint',
  'auth-canonical-import-and-createuser-shape',
  'auth-credential-signin-rich-user-and-disabled-guard',
  'auth-getidtoken-expiry-buffer-refresh',
] as const;

describe('Auth anonymous idempotency, createUser shape, credential sign-in, and token expiry buffer staged probes (sdk-probes)', () => {
  test('registers all 4 Auth probes on sdk-probes with pendingRowLink and empty rowIds', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of AUTH_ANON_CREATE_CRED_EXPIRY_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    const probes = [
      anonIdempotencyProbe,
      canonicalAndCreateProbe,
      credSignInRichAndDisabledProbe,
      tokenExpiryBufferProbe,
    ];
    for (const probeRecord of probes) {
      expect(probeRecord.rig).toBe('sdk-probes');
      expect(probeRecord.requires).toEqual(['web-config', 'admin-auth']);
      expect(probeRecord.pendingRowLink).toBe(true);
      expect(probeRecord.matrixRow).toBe('');
      expect(probeRecord.rowIds).toEqual([]);
      expect(probeRecord.description.length).toBeGreaterThan(20);
    }

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );

    expectStagedUntilCaptured(AUTH_ANON_CREATE_CRED_EXPIRY_PROBE_IDS, {
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
      lines.some((line) => line.includes('auth-getidtoken-expiry-buffer-refresh')),
    ).toBe(true);
  });
});
