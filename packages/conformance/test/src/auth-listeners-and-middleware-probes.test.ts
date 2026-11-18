import { describe, expect, test } from 'bun:test';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';
import { probe as beforeBlockProbe } from '../../probes/auth/auth-beforeauthstatechanged-block-signin-and-signout.ts';
import { probe as beforeOnAbortProbe } from '../../probes/auth/auth-beforeauthstatechanged-onabort-reverse-and-swallow.ts';
import { probe as dupAndUnsubProbe } from '../../probes/auth/auth-onauthstatechanged-duplicate-fn-and-unsub-during-emit.ts';
import { probe as sameUidDedupProbe } from '../../probes/auth/auth-onauthstatechanged-same-uid-dedup-vs-idtoken.ts';

const AUTH_LISTENER_PROBE_IDS = [
  'auth-beforeauthstatechanged-block-signin-and-signout',
  'auth-beforeauthstatechanged-onabort-reverse-and-swallow',
  'auth-onauthstatechanged-duplicate-fn-and-unsub-during-emit',
  'auth-onauthstatechanged-same-uid-dedup-vs-idtoken',
] as const;

describe('Auth listener and beforeAuthStateChanged staged probes (sdk-probes)', () => {
  test('registers all 4 Auth listener/middleware probes on sdk-probes with pendingRowLink and empty rowIds', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of AUTH_LISTENER_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    const probes = [
      beforeBlockProbe,
      beforeOnAbortProbe,
      dupAndUnsubProbe,
      sameUidDedupProbe,
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

    expectStagedUntilCaptured(AUTH_LISTENER_PROBE_IDS, {
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
      lines.some((line) =>
        line.includes('auth-beforeauthstatechanged-block-signin-and-signout'),
      ),
    ).toBe(true);
  });
});
