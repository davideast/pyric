import { describe, expect, test } from 'bun:test';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { probe as disabledAccountProbe } from '../../probes/auth/auth-disabled-account-signin-and-refresh.ts';
import { probe as handleCachingProbe } from '../../probes/auth/auth-handle-caching-live-currentuser-and-resignin.ts';
import { probe as setPersistenceProbe } from '../../probes/auth/auth-setpersistence-and-firebaseerror-wrapper.ts';

const AUTH_SLICE14_PROBE_IDS = [
  'auth-disabled-account-signin-and-refresh',
  'auth-handle-caching-live-currentuser-and-resignin',
  'auth-setpersistence-and-firebaseerror-wrapper',
] as const;

describe('Auth handle caching, persistence markers, error wrapper, and disabled-account linked probes (sdk-probes)', () => {
  test('registers all 3 Auth probes on sdk-probes with linked matrixRow and rowIds', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of AUTH_SLICE14_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    expect(handleCachingProbe.pendingRowLink).toBeUndefined();
    expect(handleCachingProbe.matrixRow).toBe('auth#1');
    expect(handleCachingProbe.rowIds).toEqual(['auth#1', 'auth#5', 'auth#16', 'auth#49e']);

    expect(setPersistenceProbe.pendingRowLink).toBeUndefined();
    expect(setPersistenceProbe.matrixRow).toBe('auth#41');
    expect(setPersistenceProbe.rowIds).toEqual(['auth#41', 'auth#42', 'auth#49f']);

    expect(disabledAccountProbe.pendingRowLink).toBeUndefined();
    expect(disabledAccountProbe.matrixRow).toBe('auth#69');
    expect(disabledAccountProbe.rowIds).toEqual(['auth#69']);

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );
    for (const id of AUTH_SLICE14_PROBE_IDS) {
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
      lines.some((line) => line.includes('auth-disabled-account-signin-and-refresh')),
    ).toBe(true);
  });
});
