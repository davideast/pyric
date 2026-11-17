import { describe, expect, it } from 'bun:test';
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
import {
  observeFirestoreCall,
  observeFirestoreIdQuery,
  scrubFirestoreOracleRunPath,
} from '../../src/firestore-probe-outcomes.ts';
import { loadObservations, type Observation } from '../../src/ledger.ts';
import { loadModularProbes, printModularProbePreview } from '../../src/sdk-probes.ts';
import {
  discoverUncapturedStagedTargets,
  loadPendingRowLinkObservations,
} from '../../src/staged-captures.ts';
import { validateCompatibilityRegistry } from '../../src/validate-registry.ts';
import { surfaceDescriptors } from '../../surfaces/load.ts';
import {
  probe as compositeOrOrderByLimitProbe,
  probeClientTopLevelCompositeFilterMixing,
} from '../../probes/firestore/firestore-composite-or-with-orderby-and-limit.ts';
import {
  probe as compositeRejectsNonFilterProbe,
  probeClientNonFilterCompositeRejection,
} from '../../probes/firestore/firestore-composite-rejects-nonfilter-constraints.ts';
import {
  probe as compositeZeroArgProbe,
  probeClientZeroArgCompositeConstruction,
} from '../../probes/firestore/firestore-composite-zero-arg-or-and.ts';
import {
  probe as limitCapsResultCountProbe,
  probeClientLimitBounds,
} from '../../probes/firestore/firestore-limit-caps-result-count.ts';
import { probe as orderByCanonicalTypeOrderProbe } from '../../probes/firestore/firestore-orderby-canonical-type-order.ts';
import { probe as orderByDirectionAscDescProbe } from '../../probes/firestore/firestore-orderby-direction-asc-desc.ts';
import { probe as orderByExcludesMissingFieldProbe } from '../../probes/firestore/firestore-orderby-excludes-missing-field.ts';
import { probe as orderByImplicitInequalityTiebreakProbe } from '../../probes/firestore/firestore-orderby-implicit-inequality-and-name-tiebreak.ts';
import { probe as queryChainingRetagsConstraintsProbe } from '../../probes/firestore/firestore-query-chaining-retags-constraints.ts';
import { probe as queryComposeWhereOrderByLimitProbe } from '../../probes/firestore/firestore-query-compose-where-orderby-limit.ts';
import { probe as whereExistenceAndNullGuardsProbe } from '../../probes/firestore/firestore-where-existence-and-null-guards.ts';
import { probe as whereTenFilterOperatorsProbe } from '../../probes/firestore/firestore-where-ten-filter-operators.ts';

const EXPECTED_QUERY_CONSTRUCTION_PROBES = [
  ['firestore-composite-or-with-orderby-and-limit', compositeOrOrderByLimitProbe],
  ['firestore-composite-rejects-nonfilter-constraints', compositeRejectsNonFilterProbe],
  ['firestore-composite-zero-arg-or-and', compositeZeroArgProbe],
  ['firestore-limit-caps-result-count', limitCapsResultCountProbe],
  ['firestore-orderby-canonical-type-order', orderByCanonicalTypeOrderProbe],
  ['firestore-orderby-direction-asc-desc', orderByDirectionAscDescProbe],
  ['firestore-orderby-excludes-missing-field', orderByExcludesMissingFieldProbe],
  ['firestore-orderby-implicit-inequality-and-name-tiebreak', orderByImplicitInequalityTiebreakProbe],
  ['firestore-query-chaining-retags-constraints', queryChainingRetagsConstraintsProbe],
  ['firestore-query-compose-where-orderby-limit', queryComposeWhereOrderByLimitProbe],
  ['firestore-where-existence-and-null-guards', whereExistenceAndNullGuardsProbe],
  ['firestore-where-ten-filter-operators', whereTenFilterOperatorsProbe],
] as const;

function makePostCaptureObservation(name: string): Observation {
  return {
    file: `${name}.json`,
    surfaceDir: 'firestore',
    name,
    matrixRow: '',
    rowIds: [],
    observedAt: '2026-11-17T00:00:00.000Z',
    fbSdkVersion: '12.19.0',
    behavior: { captured: true },
    raw: { fbSdkVersion: '12.19.0', rowIds: [] },
  };
}

describe('Firestore Query construction staged probes (sdk-probes)', () => {
  it('registers all 12 query-construction probes on sdk-probes with pendingRowLink and empty rowIds', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const byId = new Map(loaded.map((entry) => [entry.id, entry]));

    for (const [id, staticProbe] of EXPECTED_QUERY_CONSTRUCTION_PROBES) {
      const found = byId.get(id);
      expect(found, `missing modular probe ${id}`).toBeDefined();
      expect(found?.probe).toBe(staticProbe);
      expect(found?.surfaceDir).toBe('firestore');
      expect(found?.probe.rig).toBe('sdk-probes');
      expect(found?.probe.pendingRowLink).toBe(true);
      expect(found?.probe.matrixRow).toBe('');
      expect(found?.probe.rowIds).toEqual([]);
      expect(found?.probe.description.length).toBeGreaterThan(10);
      expect(typeof found?.probe.observe).toBe('function');
    }

    const previewLines: string[] = [];
    printModularProbePreview({
      rig: 'sdk-probes',
      scriptPath: 'packages/conformance/src/sdk-probes.ts',
      probes: loaded,
      log: (line) => previewLines.push(line),
    });
    const preview = previewLines.join('\n');
    for (const [id] of EXPECTED_QUERY_CONSTRUCTION_PROBES) {
      expect(preview).toContain(`${id} (observations/firestore/${id}.json`);
      expect(preview).toContain('[pendingRowLink]');
    }
  });

  it('discovers all 12 probes as uncaptured targets and validates cleanly pre-capture and post-capture', async () => {
    const existingObservations = loadObservations();
    const existingNames = new Set(existingObservations.map((obs) => obs.name));
    const uncaptured = discoverUncapturedStagedTargets().map((item) => item.observationName);
    for (const [id] of EXPECTED_QUERY_CONSTRUCTION_PROBES) {
      if (!existingNames.has(id)) {
        expect(uncaptured).toContain(id);
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

    const postCaptureByName = new Map(existingObservations.map((obs) => [obs.name, obs]));
    for (const [id] of EXPECTED_QUERY_CONSTRUCTION_PROBES) {
      postCaptureByName.set(id, makePostCaptureObservation(id));
    }
    expect(
      validateCompatibilityRegistry({
        rows: allCompatibilityRows,
        descriptors: surfaceDescriptors,
        observations: [...postCaptureByName.values()],
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

  it('normalizes sync call and async query outcomes and scrubs dynamic fs_<runId> segments', async () => {
    expect(
      scrubFirestoreOracleRunPath(
        'Missing permissions at pyric_oracle/fs_mwk123_abc987/items/d1 in project',
      ),
    ).toBe('Missing permissions at pyric_oracle/<runId>/items/d1 in project');

    const okSync = observeFirestoreCall(() => 'ok');
    expect(okSync).toEqual({
      threw: false,
      errorName: null,
      isTypeError: false,
      code: null,
      message: null,
    });

    const codedErr = Object.assign(new Error('invalid constraint at pyric_oracle/fs_99_zz/c'), {
      name: 'FirebaseError',
      code: 'invalid-argument',
    });
    const failedSync = observeFirestoreCall(() => {
      throw codedErr;
    });
    expect(failedSync).toEqual({
      threw: true,
      errorName: 'FirebaseError',
      isTypeError: false,
      code: 'invalid-argument',
      message: 'invalid constraint at pyric_oracle/<runId>/c',
    });

    const okQuery = await observeFirestoreIdQuery(async () => ({
      docs: [{ id: 'd1' }, { id: 'd2' }],
    }));
    expect(okQuery).toEqual({
      threw: false,
      ids: ['d1', 'd2'],
      code: null,
      errorName: null,
    });

    const failedQuery = await observeFirestoreIdQuery(async () => {
      throw codedErr;
    });
    expect(failedQuery).toEqual({
      threw: true,
      ids: null,
      code: 'invalid-argument',
      errorName: 'FirebaseError',
      message: 'invalid constraint at pyric_oracle/<runId>/c',
    });
  });

  it('observes upstream firebase/firestore client behavior for non-filter composites, zero-arg composites, and limit bounds', async () => {
    const nonFilter = await probeClientNonFilterCompositeRejection();
    expect(nonFilter.orWithOrderBy.threw).toBe(true);
    expect(nonFilter.orWithOrderBy.code).toBe('invalid-argument');
    expect(nonFilter.orWithOrderBy.isTypeError).toBe(false);
    expect(nonFilter.andWithLimit.threw).toBe(true);
    expect(nonFilter.andWithLimit.code).toBe('invalid-argument');
    expect(nonFilter.andWithLimit.isTypeError).toBe(false);

    const zeroArg = await probeClientZeroArgCompositeConstruction();
    expect(zeroArg.orZeroArgs.threw).toBe(false);
    expect(zeroArg.andZeroArgs.threw).toBe(false);
    expect(zeroArg.queryWithOrZeroArgs.threw).toBe(false);
    expect(zeroArg.queryWithAndZeroArgs.threw).toBe(false);

    const bounds = await probeClientLimitBounds();
    expect(bounds.limitZero.threw).toBe(true);
    expect(bounds.limitZero.code).toBe('invalid-argument');
    expect(bounds.limitNegativeOne.threw).toBe(true);
    expect(bounds.limitNegativeOne.code).toBe('invalid-argument');

    const mixing = await probeClientTopLevelCompositeFilterMixing();
    expect(mixing.orWithOrderByAndLimit.threw).toBe(false);
    expect(mixing.wherePlusOrSameCall.threw).toBe(true);
    expect(mixing.wherePlusOrSameCall.code).toBe('invalid-argument');
    expect(mixing.orPlusWhereSameCall.threw).toBe(true);
    expect(mixing.orPlusWhereSameCall.code).toBe('invalid-argument');
    expect(mixing.andWrappingWhereAndOr.threw).toBe(false);
    expect(mixing.chainedWhereThenOr.threw).toBe(false);
  });
});
