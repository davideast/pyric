import { describe, expect, test } from 'bun:test';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';
import { probe as disabledAccountProbe } from '../../probes/auth/auth-disabled-account-signin-and-refresh.ts';
import { probe as handleCachingProbe } from '../../probes/auth/auth-handle-caching-live-currentuser-and-resignin.ts';
import { probe as setPersistenceProbe } from '../../probes/auth/auth-setpersistence-and-firebaseerror-wrapper.ts';

const AUTH_SLICE14_PROBE_IDS = [
  'auth-disabled-account-signin-and-refresh',
  'auth-handle-caching-live-currentuser-and-resignin',
  'auth-setpersistence-and-firebaseerror-wrapper',
] as const;

describe('Auth handle caching, persistence markers, error wrapper, and disabled-account staged probes (sdk-probes)', () => {
  test('registers all 3 Auth probes on sdk-probes with pendingRowLink and empty rowIds', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of AUTH_SLICE14_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    const probes = [handleCachingProbe, setPersistenceProbe, disabledAccountProbe];
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

    expectStagedUntilCaptured(AUTH_SLICE14_PROBE_IDS, {
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
      lines.some((line) => line.includes('auth-disabled-account-signin-and-refresh')),
    ).toBe(true);
  });
});
