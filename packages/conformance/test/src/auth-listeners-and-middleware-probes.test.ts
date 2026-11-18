import { describe, expect, test } from 'bun:test';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
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

describe('Auth listener and beforeAuthStateChanged linked probes (sdk-probes)', () => {
  test('registers all 4 Auth listener/middleware probes linked to auth#30a, #33a, #34, #38a, #76, #76a, #76b', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of AUTH_LISTENER_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    expect(sameUidDedupProbe.pendingRowLink).toBeUndefined();
    expect(sameUidDedupProbe.matrixRow).toBe('auth#30a');
    expect(sameUidDedupProbe.rowIds).toEqual(['auth#30a', 'auth#38a']);

    expect(dupAndUnsubProbe.pendingRowLink).toBeUndefined();
    expect(dupAndUnsubProbe.matrixRow).toBe('auth#33a');
    expect(dupAndUnsubProbe.rowIds).toEqual(['auth#33a', 'auth#34']);

    expect(beforeBlockProbe.pendingRowLink).toBeUndefined();
    expect(beforeBlockProbe.matrixRow).toBe('auth#76');
    expect(beforeBlockProbe.rowIds).toEqual(['auth#76', 'auth#76b']);

    expect(beforeOnAbortProbe.pendingRowLink).toBeUndefined();
    expect(beforeOnAbortProbe.matrixRow).toBe('auth#76a');
    expect(beforeOnAbortProbe.rowIds).toEqual(['auth#76a']);

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );
    for (const id of AUTH_LISTENER_PROBE_IDS) {
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
      lines.some((line) =>
        line.includes('auth-beforeauthstatechanged-block-signin-and-signout'),
      ),
    ).toBe(true);
  });
});
