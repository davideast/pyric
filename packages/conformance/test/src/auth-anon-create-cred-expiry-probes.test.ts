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

const ALL_PROBE_IDS = [
  'auth-anonymous-idempotency-and-remint',
  'auth-canonical-import-and-createuser-shape',
  'auth-credential-signin-rich-user-and-disabled-guard',
  'auth-getidtoken-expiry-buffer-refresh',
] as const;

const LINKED_PROBE_IDS = [
  'auth-anonymous-idempotency-and-remint',
  'auth-credential-signin-rich-user-and-disabled-guard',
  'auth-getidtoken-expiry-buffer-refresh',
] as const;

const STAGED_PROBE_IDS = ['auth-canonical-import-and-createuser-shape'] as const;

describe('Auth anonymous idempotency, createUser shape, credential sign-in, and token expiry buffer probes (sdk-probes)', () => {
  test('registers linked rowIds for anonymous, credential sign-in, and token expiry probes while keeping canonical-import staged', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of ALL_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    for (const probeRecord of [
      anonIdempotencyProbe,
      canonicalAndCreateProbe,
      credSignInRichAndDisabledProbe,
      tokenExpiryBufferProbe,
    ]) {
      expect(probeRecord.rig).toBe('sdk-probes');
      expect(probeRecord.requires).toEqual(['web-config', 'admin-auth']);
      expect(probeRecord.description.length).toBeGreaterThan(20);
    }

    expect(anonIdempotencyProbe.pendingRowLink).toBeUndefined();
    expect(anonIdempotencyProbe.matrixRow).toBe('auth#8');
    expect(anonIdempotencyProbe.rowIds).toEqual(['auth#8', 'auth#9']);

    expect(credSignInRichAndDisabledProbe.pendingRowLink).toBeUndefined();
    expect(credSignInRichAndDisabledProbe.matrixRow).toBe('auth#47a');
    expect(credSignInRichAndDisabledProbe.rowIds).toEqual(['auth#47a', 'auth#70']);

    expect(tokenExpiryBufferProbe.pendingRowLink).toBeUndefined();
    expect(tokenExpiryBufferProbe.matrixRow).toBe('auth#55a');
    expect(tokenExpiryBufferProbe.rowIds).toEqual(['auth#55a']);

    expect(canonicalAndCreateProbe.pendingRowLink).toBe(true);
    expect(canonicalAndCreateProbe.matrixRow).toBe('');
    expect(canonicalAndCreateProbe.rowIds).toEqual([]);

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );
    for (const linkedId of LINKED_PROBE_IDS) {
      expect(unfilteredIds.has(linkedId)).toBe(true);
    }

    expectStagedUntilCaptured(STAGED_PROBE_IDS, {
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
