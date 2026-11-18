import { describe, expect, test } from 'bun:test';
import { observationExceptions } from '../../exceptions/load.ts';
import { listProbeFiles } from '../../probes/load.ts';
import { allCompatibilityRows } from '../../registry/index.ts';
import { loadRigManifests } from '../../rigs/load.ts';
import { ALL_RULES_FIRESTORE_SCENARIOS } from '../../rules-corpus/firestore/index.ts';
import {
  ALL_RULES_RTDB_DEPLOY_SCENARIOS,
  ALL_RULES_RTDB_SCENARIOS,
} from '../../rules-corpus/rtdb/index.ts';
import { ALL_RULES_STORAGE_SCENARIOS } from '../../rules-corpus/storage/index.ts';
import { decodeJwtParts, deepEqualJsonValues } from '../../src/auth-user-probe-session.ts';
import { loadObservations } from '../../src/ledger.ts';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { loadPendingRowLinkObservations } from '../../src/staged-captures.ts';
import { validateCompatibilityRegistry } from '../../src/validate-registry.ts';
import { surfaceDescriptors } from '../../surfaces/load.ts';
import { probe as updateProfileProbe } from '../../probes/auth/auth-updateprofile-in-place-and-persistence.ts';
import { probe as emailVerifiedProbe } from '../../probes/auth/auth-user-email-verified-passthrough.ts';
import { probe as getIdTokenJwtProbe } from '../../probes/auth/auth-user-getidtoken-jwt-structure.ts';
import { probe as getIdTokenResultProbe } from '../../probes/auth/auth-user-getidtokenresult-claims-shape.ts';
import { probe as identityFieldsProbe } from '../../probes/auth/auth-user-identity-fields-by-source.ts';
import { probe as photoPhoneProviderProbe } from '../../probes/auth/auth-user-photo-phone-and-provider-data.ts';

const EXPECTED_AUTH_USER_PROBES = [
  ['auth-user-getidtoken-jwt-structure', getIdTokenJwtProbe, 'auth#54', ['auth#54']],
  ['auth-user-getidtokenresult-claims-shape', getIdTokenResultProbe, 'auth#56', ['auth#56']],
  ['auth-user-identity-fields-by-source', identityFieldsProbe, 'auth#57', ['auth#57']],
  ['auth-user-email-verified-passthrough', emailVerifiedProbe, 'auth#58', ['auth#58']],
  [
    'auth-user-photo-phone-and-provider-data',
    photoPhoneProviderProbe,
    'auth#58a',
    ['auth#58a', 'auth#58b'],
  ],
  ['auth-updateprofile-in-place-and-persistence', updateProfileProbe, 'auth#62', ['auth#62']],
] as const;

describe('Auth User methods linked probes (sdk-probes)', () => {
  test('registers all 6 Auth User method probes on sdk-probes linked to their target registry rows', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );

    for (const [id, probeRecord, expectedMatrixRow, expectedRowIds] of EXPECTED_AUTH_USER_PROBES) {
      const found = loaded.find((entry) => entry.id === id);
      expect(found, `missing modular probe ${id}`).toBeDefined();
      expect(found?.probe).toBe(probeRecord);
      expect(probeRecord.rig).toBe('sdk-probes');
      expect(probeRecord.requires).toEqual(['web-config', 'admin-auth']);
      expect(probeRecord.pendingRowLink).toBeUndefined();
      expect(probeRecord.matrixRow).toBe(expectedMatrixRow);
      expect(probeRecord.rowIds).toEqual([...expectedRowIds]);
      expect(probeRecord.description.length).toBeGreaterThan(20);
      expect(unfilteredIds.has(id)).toBe(true);
    }

    const lines: string[] = [];
    printModularProbePreview({
      rig: 'sdk-probes',
      scriptPath: 'packages/conformance/src/sdk-probes.ts',
      probes: loaded,
      log: (line) => lines.push(line),
    });
    expect(lines.some((line) => line.includes('auth-user-getidtoken-jwt-structure'))).toBe(true);
  });

  test('links all 6 committed observations to 7 oracle-backed registry rows with zero validation problems', async () => {
    const existingObservations = loadObservations();
    const obsByName = new Map(existingObservations.map((obs) => [obs.name, obs]));
    const rowsById = new Map(allCompatibilityRows.map((row) => [row.id, row]));

    for (const [id, , expectedMatrixRow, expectedRowIds] of EXPECTED_AUTH_USER_PROBES) {
      const obs = obsByName.get(id);
      expect(obs, `missing committed observation ${id}`).toBeDefined();
      expect(obs?.matrixRow).toBe(expectedMatrixRow);
      expect(obs?.rowIds).toEqual([...expectedRowIds]);

      for (const rowId of expectedRowIds) {
        const row = rowsById.get(rowId);
        expect(row, `missing compatibility row ${rowId}`).toBeDefined();
        expect(row?.automation).toBe('oracle-backed');
        expect(row?.oracleObservations).toContain(id);
      }
    }

    const rigManifests = await loadRigManifests();
    const probeFiles = listProbeFiles();
    const pendingRowLinkObservations = loadPendingRowLinkObservations();
    const rulesFirestoreScenarioIds = ALL_RULES_FIRESTORE_SCENARIOS.map((s) => s.id);
    const rulesStorageScenarioIds = ALL_RULES_STORAGE_SCENARIOS.map((s) => s.id);
    const rulesRtdbScenarioIds = [
      ...ALL_RULES_RTDB_SCENARIOS.map((s) => s.id),
      ...ALL_RULES_RTDB_DEPLOY_SCENARIOS.map((s) => s.id),
    ];

    expect(
      validateCompatibilityRegistry({
        rows: allCompatibilityRows,
        descriptors: surfaceDescriptors,
        observations: existingObservations,
        observationExceptions,
        rigManifests,
        probeFiles,
        rulesFirestoreScenarioIds,
        rulesStorageScenarioIds,
        rulesRtdbScenarioIds,
        pendingRowLinkObservations,
      }),
    ).toEqual([]);
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
