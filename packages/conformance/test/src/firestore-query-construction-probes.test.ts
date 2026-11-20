import net from 'node:net';
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
  observeFirestoreNotInQuery,
  runFirestoreRestNotInQuery,
  runNodeFirestoreNotInSubprocess,
} from '../../src/firestore-not-in-probe.ts';
import {
  FirestoreQueryTimeoutError,
  observeFirestoreCall,
  observeFirestoreIdQuery,
  scrubFirestoreOracleRunPath,
} from '../../src/firestore-probe-outcomes.ts';
import { loadObservations } from '../../src/ledger.ts';
import { loadModularProbes, printModularProbePreview } from '../../src/sdk-probes.ts';
import { loadPendingRowLinkObservations } from '../../src/staged-captures.ts';
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
  ['firestore-composite-or-with-orderby-and-limit', 'firestore#62', compositeOrOrderByLimitProbe],
  ['firestore-composite-rejects-nonfilter-constraints', 'firestore#63', compositeRejectsNonFilterProbe],
  ['firestore-composite-zero-arg-or-and', 'firestore#64', compositeZeroArgProbe],
  ['firestore-limit-caps-result-count', 'firestore#60', limitCapsResultCountProbe],
  ['firestore-orderby-canonical-type-order', 'firestore#59a', orderByCanonicalTypeOrderProbe],
  ['firestore-orderby-direction-asc-desc', 'firestore#59', orderByDirectionAscDescProbe],
  ['firestore-orderby-excludes-missing-field', 'firestore#59b', orderByExcludesMissingFieldProbe],
  [
    'firestore-orderby-implicit-inequality-and-name-tiebreak',
    'firestore#59c',
    orderByImplicitInequalityTiebreakProbe,
  ],
  ['firestore-query-chaining-retags-constraints', 'firestore#65', queryChainingRetagsConstraintsProbe],
  ['firestore-query-compose-where-orderby-limit', 'firestore#54', queryComposeWhereOrderByLimitProbe],
  ['firestore-where-existence-and-null-guards', 'firestore#55a', whereExistenceAndNullGuardsProbe],
  ['firestore-where-ten-filter-operators', 'firestore#55', whereTenFilterOperatorsProbe],
] as const;

describe('Firestore Query construction linked probes (sdk-probes)', () => {
  it('registers all 12 query-construction probes on sdk-probes linked to their target registry rows', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const byId = new Map(loaded.map((entry) => [entry.id, entry]));

    for (const [id, expectedRowId, staticProbe] of EXPECTED_QUERY_CONSTRUCTION_PROBES) {
      const found = byId.get(id);
      expect(found, `missing modular probe ${id}`).toBeDefined();
      expect(found?.probe).toBe(staticProbe);
      expect(found?.surfaceDir).toBe('firestore');
      expect(found?.probe.rig).toBe('sdk-probes');
      expect(found?.probe.pendingRowLink).toBeUndefined();
      expect(found?.probe.matrixRow).toBe(expectedRowId);
      expect(found?.probe.rowIds).toEqual([expectedRowId]);
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
    }
  });

  it('links all 12 committed observations to oracle-backed registry rows with zero validation problems', async () => {
    const existingObservations = loadObservations();
    const obsByName = new Map(existingObservations.map((obs) => [obs.name, obs]));
    const rowsById = new Map(allCompatibilityRows.map((row) => [row.id, row]));

    for (const [id, expectedRowId] of EXPECTED_QUERY_CONSTRUCTION_PROBES) {
      const obs = obsByName.get(id);
      expect(obs, `missing committed observation ${id}`).toBeDefined();
      expect(obs?.rowIds).toEqual([expectedRowId]);
      expect(obs?.matrixRow).toBe(expectedRowId);

      const row = rowsById.get(expectedRowId);
      expect(row, `missing compatibility row ${expectedRowId}`).toBeDefined();
      expect(row?.automation).toBe('oracle-backed');
      expect(row?.oracleObservations).toContain(id);
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

  it('normalizes sync and async outcomes, scrubs fs_<runId>, and fails closed on query timeouts', async () => {
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

    // Harness hangs must throw FirestoreQueryTimeoutError rather than returning
    // a synthetic timeout outcome that would pollute committed observations.
    let caughtTimeout: unknown = null;
    try {
      await observeFirestoreIdQuery(() => new Promise(() => {}), 25);
    } catch (err) {
      caughtTimeout = err;
    }
    expect(caughtTimeout).toBeInstanceOf(FirestoreQueryTimeoutError);
    expect((caughtTimeout as Error).message).toContain(
      'refusing to record a harness timeout as observed production behavior',
    );
  });

  it('runs not-in probes through Node first, falls back to Firestore REST runQuery on timeout, and fails closed if both fail', async () => {
    let restCalled = false;
    const fromNode = await observeFirestoreNotInQuery({
      webConfig: { projectId: 'demo-proj', apiKey: 'demo-key' },
      collectionPath: 'pyric_oracle/fs_t1_aa/where-ten-ops',
      field: 'num',
      values: [10, 30],
      runNodeQuery: async () => ({
        threw: false,
        ids: ['d2', 'd4'],
        code: null,
        errorName: null,
        transport: 'firebase-js-sdk-node',
      }),
      runRestQuery: async () => {
        restCalled = true;
        throw new Error('unexpected REST fallback');
      },
    });
    expect(restCalled).toBe(false);
    expect(fromNode).toEqual({
      threw: false,
      ids: ['d2', 'd4'],
      code: null,
      errorName: null,
      transport: 'firebase-js-sdk-node',
    });

    let capturedUrl = '';
    let capturedAuth = '';
    let capturedBody = '';
    const fromRestDocs = await observeFirestoreNotInQuery({
      webConfig: { projectId: 'demo-proj', apiKey: 'demo-key' },
      collectionPath: 'pyric_oracle/fs_t2_bb/where-existence-null',
      field: 'val',
      values: [10],
      runNodeQuery: async () => {
        throw new FirestoreQueryTimeoutError(50, 'node firebase/firestore (query)');
      },
      runRestQuery: async (params) =>
        runFirestoreRestNotInQuery({
          projectId: 'demo-proj',
          accessToken: 'tok-123',
          collectionPath: params.collectionPath,
          field: params.field,
          values: params.values,
          fetchImpl: async (url, init) => {
            capturedUrl = url;
            capturedAuth = init.headers.Authorization ?? '';
            capturedBody = init.body;
            return new Response(
              JSON.stringify([
                {
                  document: {
                    name: 'projects/demo-proj/databases/(default)/documents/pyric_oracle/fs_t2_bb/where-existence-null/twenty',
                  },
                },
                { readTime: '2026-11-17T00:00:00Z' },
              ]),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          },
        }),
    });
    expect(capturedUrl).toBe(
      'https://firestore.googleapis.com/v1/projects/demo-proj/databases/(default)/documents/pyric_oracle/fs_t2_bb:runQuery',
    );
    expect(capturedAuth).toBe('Bearer tok-123');
    expect(JSON.parse(capturedBody)).toEqual({
      structuredQuery: {
        from: [{ collectionId: 'where-existence-null' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'val' },
            op: 'NOT_IN',
            value: {
              arrayValue: {
                values: [{ integerValue: '10' }],
              },
            },
          },
        },
        orderBy: [
          { field: { fieldPath: 'val' }, direction: 'ASCENDING' },
          { field: { fieldPath: '__name__' }, direction: 'ASCENDING' },
        ],
      },
    });
    expect(fromRestDocs).toEqual({
      threw: false,
      ids: ['twenty'],
      code: null,
      errorName: null,
      transport: 'firestore-rest-runQuery',
    });

    let nullBody = '';
    const fromRestInvalidArg = await runFirestoreRestNotInQuery({
      projectId: 'demo-proj',
      accessToken: 'tok-123',
      collectionPath: 'pyric_oracle/fs_t3_cc/where-existence-null',
      field: 'val',
      values: [10, null],
      fetchImpl: async (_url, init) => {
        nullBody = init.body;
        return new Response(
          JSON.stringify([
            {
              error: {
                code: 400,
                status: 'INVALID_ARGUMENT',
                message:
                  'Null value is not allowed for NOT_IN at pyric_oracle/fs_t3_cc/where-existence-null',
              },
            },
          ]),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });
    expect(JSON.parse(nullBody).structuredQuery.where.fieldFilter.value.arrayValue.values).toEqual([
      { integerValue: '10' },
      { nullValue: 'NULL_VALUE' },
    ]);
    expect(fromRestInvalidArg).toEqual({
      threw: true,
      ids: null,
      code: 'invalid-argument',
      errorName: 'FirebaseError',
      message: 'Null value is not allowed for NOT_IN at pyric_oracle/<runId>/where-existence-null',
      transport: 'firestore-rest-runQuery',
    });

    // Non-query HTTP statuses (403 IAM, 503 outage) and double timeouts fail closed.
    let skipErr: unknown = null;
    try {
      await observeFirestoreNotInQuery({
        webConfig: { projectId: 'demo-proj', apiKey: 'demo-key' },
        collectionPath: 'pyric_oracle/fs_t4_dd/where-existence-null',
        field: 'val',
        values: [10],
        runNodeQuery: async () => {
          throw new FirestoreQueryTimeoutError(50, 'node timeout');
        },
        runRestQuery: async (params) =>
          runFirestoreRestNotInQuery({
            projectId: 'demo-proj',
            accessToken: 'tok-123',
            collectionPath: params.collectionPath,
            field: params.field,
            values: params.values,
            fetchImpl: async () =>
              new Response(JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED' } }), {
                status: 403,
              }),
          }),
      });
    } catch (err) {
      skipErr = err;
    }
    expect(skipErr).toBeInstanceOf(Error);
    expect((skipErr as Error).message).toContain('Skipped Firestore not-in probe');
  });

  // runNodeFirestoreNotInSubprocess enforces a timeoutMs + 12s hard-kill bound;
  // keep the test budget above that bound so cold Node/ESM startup under CI load
  // cannot trip bun test's 5s default before the subprocess or its hard-kill settles.
  it(
    'bounds and terminates the real Node firebase/firestore subprocess cleanly when a stream stalls',
    async () => {
      const sockets = new Set<net.Socket>();
      const blackhole = net.createServer((sock) => {
        sockets.add(sock);
        sock.on('error', () => undefined);
        sock.on('close', () => sockets.delete(sock));
      });
      await new Promise<void>((resolve) => {
        blackhole.listen(0, '127.0.0.1', () => resolve());
      });
      const addr = blackhole.address();
      let port = 0;
      if (addr && typeof addr === 'object') {
        port = addr.port;
      }

      let caught: unknown = null;
      try {
        await runNodeFirestoreNotInSubprocess({
          webConfig: { projectId: 'demo-blackhole', apiKey: 'demo-key' },
          collectionPath: 'pyric_oracle/fs_bh_1/items',
          field: 'val',
          values: [10],
          timeoutMs: 80,
          emulatorHost: { host: '127.0.0.1', port },
        });
      } catch (err) {
        caught = err;
      } finally {
        for (const sock of sockets) {
          sock.destroy();
        }
        await new Promise<void>((resolve) => {
          blackhole.close(() => resolve());
        });
      }

      expect(caught).toBeInstanceOf(FirestoreQueryTimeoutError);
      expect((caught as Error).message).toMatch(/node (firebase\/firestore|subprocess hard-timeout)/);
    },
    30_000,
  );

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
