import { describe, expect, test } from 'bun:test';
import { decodeJwtParts, deepEqualJsonValues } from '../../src/auth-user-probe-session.ts';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';
import { probe as updateProfileProbe } from '../../probes/auth/auth-updateprofile-in-place-and-persistence.ts';
import { probe as emailVerifiedProbe } from '../../probes/auth/auth-user-email-verified-passthrough.ts';
import { probe as getIdTokenJwtProbe } from '../../probes/auth/auth-user-getidtoken-jwt-structure.ts';
import { probe as getIdTokenResultProbe } from '../../probes/auth/auth-user-getidtokenresult-claims-shape.ts';
import { probe as identityFieldsProbe } from '../../probes/auth/auth-user-identity-fields-by-source.ts';
import { probe as photoPhoneProviderProbe } from '../../probes/auth/auth-user-photo-phone-and-provider-data.ts';

const AUTH_USER_PROBE_IDS = [
  'auth-updateprofile-in-place-and-persistence',
  'auth-user-email-verified-passthrough',
  'auth-user-getidtoken-jwt-structure',
  'auth-user-getidtokenresult-claims-shape',
  'auth-user-identity-fields-by-source',
  'auth-user-photo-phone-and-provider-data',
] as const;

describe('Auth User methods staged probes (sdk-probes)', () => {
  test('registers all 6 Auth User method probes on sdk-probes with pendingRowLink and empty rowIds', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of AUTH_USER_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    const probes = [
      updateProfileProbe,
      emailVerifiedProbe,
      getIdTokenJwtProbe,
      getIdTokenResultProbe,
      identityFieldsProbe,
      photoPhoneProviderProbe,
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

    expectStagedUntilCaptured(AUTH_USER_PROBE_IDS, {
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
    expect(lines.some((line) => line.includes('auth-user-getidtoken-jwt-structure'))).toBe(true);
  });

  test('decodes base64url JWT segments and compares nested JSON claim objects independent of key order', () => {
    const header = Buffer.from(
      JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'key-1' }),
      'utf8',
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: 'user-1', firebase: { sign_in_provider: 'password', identities: {} } }),
      'utf8',
    ).toString('base64url');
    const signature = Buffer.from('sig-bytes', 'utf8').toString('base64url');

    const decoded = decodeJwtParts(`${header}.${payload}.${signature}`);
    expect(decoded.segmentCount).toBe(3);
    expect(decoded.allSegmentsBase64Url).toBe(true);
    expect(decoded.header).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'key-1' });
    expect(
      deepEqualJsonValues(decoded.payload, {
        firebase: { identities: {}, sign_in_provider: 'password' },
        sub: 'user-1',
      }),
    ).toBe(true);
    expect(
      deepEqualJsonValues(decoded.payload, {
        firebase: { identities: {}, sign_in_provider: 'anonymous' },
        sub: 'user-1',
      }),
    ).toBe(false);

    const malformed = decodeJwtParts('only-two.segments');
    expect(malformed.segmentCount).toBe(2);
    expect(malformed.header).toEqual({});
    expect(malformed.payload).toEqual({});
  });
});
