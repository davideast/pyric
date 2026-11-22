/**
 * Firestore candidate-rules verification across `(default)` and named databases.
 */
import {
  replay as replayFirestore,
  type Divergence,
  type WriteSandboxEvent,
} from 'pyric/sandbox';
import {
  isFirestoreServiceName,
  parseToASTOrError,
  resolveModulesBrowser,
  rulesSourceRejection,
  SimulateFirestoreRulesHandler,
  Timestamp,
  type TestCase,
  type TestResult,
} from 'pyric/rules/internal';

import { deriveRulesTestCases } from './cases.js';
import {
  filterFixtureForFirestoreDatabase,
  recordedFirestoreDatabases,
  recordsDefaultFirestoreDatabase,
} from './firestore-databases.js';
import {
  buildPointInTimeFirestoreDocs,
  decodeCapturedFirestoreDoc,
  decodeCapturedFirestoreDocStore,
  readOwnDocument,
  reconstructInitialFirestoreDocuments,
  resolveProjectedServerTimestamps,
} from './firestore-doc-history.js';
import {
  addEngineDrift,
  verifyFirestoreRulesTestApi,
  verifyLiveFirestoreCalls,
} from './firestore-live-verify.js';
import type { PyricVerifyFixture } from './fixture.js';
import {
  VerifyInputError,
  type VerifyDivergence,
  type VerifyEngine,
  type VerifyEngineResult,
  type VerifyFixtureOptions,
  type VerifyRulesInput,
  type VerifyServiceResult,
} from './index.js';

type FirestoreCandidateSource = string | { source: string };

function isInformational(divergence: VerifyDivergence): boolean {
  return divergence.kind === 'expected-drift';
}

function withDatabaseTag(
  divergence: VerifyDivergence,
  database: string | undefined,
): VerifyDivergence {
  if (database === undefined) return divergence;
  return { ...divergence, database };
}

export async function verifyFirestore(
  fixture: PyricVerifyFixture,
  rulesInput: VerifyRulesInput,
  engines: VerifyEngine[],
  opts: VerifyFixtureOptions,
): Promise<VerifyServiceResult> {
  const firestore = fixture.services.firestore;
  if (!firestore) {
    throw new VerifyInputError('fixture does not contain services.firestore.');
  }

  const checks: Array<{
    database?: string;
    rules: string;
    scopedFixture: PyricVerifyFixture;
  }> = [];
  const checksDefault =
    rulesInput.firestore !== undefined || recordsDefaultFirestoreDatabase(fixture);
  if (checksDefault) {
    checks.push({
      rules: requireFirestoreRules(
        rulesInput.firestore,
        'missing candidate Firestore rules. Pass rules.firestore.',
      ),
      scopedFixture: filterFixtureForFirestoreDatabase(fixture, undefined),
    });
  }

  const skippedDatabases: string[] = [];
  for (const database of recordedFirestoreDatabases(fixture)) {
    let candidate: NonNullable<VerifyRulesInput['firestoreDatabases']>[string] | undefined;
    if (
      rulesInput.firestoreDatabases !== undefined &&
      Object.hasOwn(rulesInput.firestoreDatabases, database)
    ) {
      candidate = rulesInput.firestoreDatabases[database];
    }
    if (candidate === undefined) {
      skippedDatabases.push(database);
      continue;
    }
    const parsed = requireFirestoreRules(
      candidate,
      `missing candidate Firestore rules for database "${database}".`,
      database,
    );
    checks.push({
      database,
      rules: parsed,
      scopedFixture: filterFixtureForFirestoreDatabase(fixture, database),
    });
  }

  const engineResults: Partial<Record<VerifyEngine, VerifyEngineResult>> = {};
  if (engines.includes('sandbox')) {
    const sandboxRuns = checks.map((check) => {
      const run = verifyFirestoreSandbox(check.scopedFixture, check.rules);
      return {
        ...run,
        divergences: run.divergences.map((item) => withDatabaseTag(item, check.database)),
      };
    });
    const divergences = sandboxRuns.flatMap((run) => run.divergences);
    engineResults.sandbox = {
      engine: 'sandbox',
      ok: divergences.every(isInformational),
      checkedEvents: sandboxRuns.reduce((sum, run) => sum + run.checkedEvents, 0),
      divergences,
    };
  }

  if (engines.includes('rulesTestApi')) {
    const apiRuns: VerifyEngineResult[] = [];
    for (const check of checks) {
      const run = await verifyFirestoreRulesTestApi(check.scopedFixture, check.rules, opts);
      if (engines.includes('sandbox')) {
        addEngineDrift(check.rules, run);
      }
      apiRuns.push({
        ...run,
        divergences: run.divergences.map((item) => withDatabaseTag(item, check.database)),
      });
    }
    const divergences = apiRuns.flatMap((run) => run.divergences);
    const aggregated: VerifyEngineResult = {
      engine: 'rulesTestApi',
      ok: divergences.every(isInformational) && apiRuns.every((run) => run.ok),
      checkedEvents: apiRuns.reduce((sum, run) => sum + run.checkedEvents, 0),
      testCases: apiRuns.reduce((sum, run) => sum + (run.testCases ?? 0), 0),
      passed: apiRuns.reduce((sum, run) => sum + (run.passed ?? 0), 0),
      failed: apiRuns.reduce((sum, run) => sum + (run.failed ?? 0), 0),
      unsupported: apiRuns.reduce((sum, run) => sum + (run.unsupported ?? 0), 0),
      divergences,
    };
    if (apiRuns.length === 1 && apiRuns[0] !== undefined) {
      if (apiRuns[0].derivation !== undefined) aggregated.derivation = apiRuns[0].derivation;
      if (apiRuns[0].results !== undefined) aggregated.results = apiRuns[0].results;
    }
    engineResults.rulesTestApi = aggregated;
  }

  const divergences = Object.values(engineResults).flatMap((res) => res?.divergences ?? []);
  const checkedEvents =
    engineResults.sandbox?.checkedEvents ?? engineResults.rulesTestApi?.checkedEvents ?? 0;
  const serviceResult: VerifyServiceResult = {
    service: 'firestore',
    ok:
      divergences.every(isInformational) &&
      Object.values(engineResults).every((res) => res?.ok !== false),
    checkedEvents,
    divergences,
    engines: engineResults,
  };
  if (skippedDatabases.length > 0) {
    serviceResult.skippedDatabases = skippedDatabases;
  }
  return serviceResult;
}

function verifyFirestoreSandbox(
  fixture: PyricVerifyFixture,
  rules: string,
): VerifyEngineResult {
  const firestore = fixture.services.firestore;
  if (!firestore) {
    throw new VerifyInputError('fixture does not contain services.firestore.');
  }

  const decodedFinalDocuments = decodeCapturedFirestoreDocStore(firestore.state.documents);
  const initialData = reconstructInitialFirestoreDocuments(fixture, decodedFinalDocuments);
  const seedWrites: WriteSandboxEvent[] = Object.entries(initialData).map(
    ([path, data], index) => ({
      kind: 'write',
      id: `__verify_seed_${index}__`,
      at: 0,
      method: 'set',
      path,
      auth: null,
      data,
      priorState: null,
      nextState: data,
      requestTime: { seconds: 0, nanoseconds: 0 },
      detail: { admin: true },
    }),
  );

  const replayEvents = seedWrites.length > 0 ? [...seedWrites, ...fixture.events] : fixture.events;
  const { divergences } = replayFirestore(replayEvents, rules, {}, decodedFinalDocuments);
  const mapped = divergences.map(mapFirestoreDivergence);

  const docsByEventId = buildPointInTimeFirestoreDocs(fixture, initialData);
  const derivation = deriveRulesTestCases(fixture, {
    service: 'firestore',
    includeListenerReads: true,
    mockReads: 'omit',
  });
  const committedGroupIds = new Set<string>();
  const groupIdByEventId = new Map<string, string>();
  const batchProjectionByGroupId = new Map<string, Map<string, Record<string, unknown> | null>>();
  for (const event of fixture.events) {
    const groupId = (event as { groupId?: unknown }).groupId;
    if (typeof groupId === 'string') {
      groupIdByEventId.set(event.id, groupId);
      if (event.kind === 'write') {
        committedGroupIds.add(groupId);
        let proj = batchProjectionByGroupId.get(groupId);
        if (!proj) {
          proj = new Map();
          batchProjectionByGroupId.set(groupId, proj);
        }
        let nextDoc: Record<string, unknown> | null = null;
        if (event.method !== 'delete' && event.nextState !== null) {
          nextDoc = decodeCapturedFirestoreDoc(event.nextState, event.nextUnescapedPaths);
        }
        proj.set(event.path, nextDoc);
      }
    }
  }
  for (const { eventId, testCase: tc } of derivation.derived) {
    const groupId = groupIdByEventId.get(eventId);
    if (!groupId || committedGroupIds.has(groupId)) continue;
    if (tc.method === 'get' || tc.method === 'list') continue;
    let proj = batchProjectionByGroupId.get(groupId);
    if (!proj) {
      proj = new Map();
      batchProjectionByGroupId.set(groupId, proj);
    }
    let resolvedTime = Timestamp.fromMillis(Date.now());
    if (tc.requestTime) {
      resolvedTime = Timestamp.fromIsoString(tc.requestTime);
    }
    let projectedDoc: Record<string, unknown> | null = null;
    if (tc.method !== 'delete' && tc.data !== undefined) {
      projectedDoc = resolveProjectedServerTimestamps(tc.data, resolvedTime) as Record<
        string,
        unknown
      >;
    }
    proj.set(tc.path, projectedDoc);
  }
  const readCases = derivation.testCases.filter(
    (tc) => tc.method === 'get' || tc.method === 'list',
  );
  const deniedWriteCases = derivation.testCases.filter(
    (tc) => tc.method !== 'get' && tc.method !== 'list' && tc.expectation === 'DENY',
  );
  const rolledBackAllowedWriteCases = derivation.derived.filter(({ eventId, testCase: tc }) => {
    if (tc.method === 'get' || tc.method === 'list' || tc.expectation !== 'ALLOW') return false;
    const groupId = groupIdByEventId.get(eventId);
    return groupId !== undefined && !committedGroupIds.has(groupId);
  });

  if (derivation.derived.length > 0) {
    const simulator = new SimulateFirestoreRulesHandler();
    for (const { eventId, testCase: tc } of derivation.derived) {
      const isRead = tc.method === 'get' || tc.method === 'list';
      const pointInTimeDocs = docsByEventId.get(eventId) ?? decodedFinalDocuments;
      const groupId = groupIdByEventId.get(eventId);
      const batchProjection = groupId ? batchProjectionByGroupId.get(groupId) : undefined;
      const simOpts: Parameters<SimulateFirestoreRulesHandler['simulate']>[2] = {
        getDoc: (docPath) => readOwnDocument(pointInTimeDocs, docPath),
      };
      if (!isRead && batchProjection) {
        simOpts.batchProjection = batchProjection;
      }
      const simulated = simulator.simulate(rules, [tc], simOpts);
      if (!simulated.success) {
        mapped.push({
          service: 'firestore',
          kind: 'unsupported',
          path: tc.path,
          method: tc.method,
          reason: simulated.error.message,
        });
        break;
      }
      const testResult = simulated.data.results[0];
      if (!testResult) continue;
      const queryUnprovable =
        tc.method === 'list' &&
        testResult.queryProof !== undefined &&
        !testResult.queryProof.provable;
      const effectiveDecision = queryUnprovable ? 'DENY' : testResult.decision;
      recordSimulatedCaseDivergence(
        mapped,
        tc,
        testResult,
        effectiveDecision,
        isRead,
        firestore.state.documents,
        initialData,
      );
    }
  }

  const live = verifyLiveFirestoreCalls(fixture, rules);
  mapped.push(...live.divergences);

  return {
    engine: 'sandbox',
    ok: mapped.every(isInformational),
    checkedEvents:
      fixture.events.filter(isProtectedFirestoreWrite).length +
      readCases.length +
      deniedWriteCases.length +
      rolledBackAllowedWriteCases.length +
      live.checkedEvents,
    divergences: mapped,
  };
}

function recordSimulatedCaseDivergence(
  mapped: VerifyDivergence[],
  tc: TestCase,
  testResult: TestResult,
  effectiveDecision: string,
  isRead: boolean,
  finalDocs: Record<string, Record<string, unknown>>,
  initialData: Record<string, Record<string, unknown>>,
): void {
  if (isRead) {
    if (effectiveDecision === 'UNSUPPORTED') {
      mapped.push({
        service: 'firestore',
        kind: 'unsupported',
        path: tc.path,
        method: tc.method,
        reason: testResult.notes.join('\n') || 'unsupported read simulation',
      });
    } else if (tc.expectation === 'ALLOW' && effectiveDecision !== 'ALLOW') {
      mapped.push({
        service: 'firestore',
        kind: 'now-denied',
        path: tc.path,
        method: tc.method,
        reason:
          testResult.queryProof?.reason ??
          (testResult.notes.join('\n') || `expected ALLOW, got ${effectiveDecision}`),
      });
    } else if (tc.expectation === 'DENY' && effectiveDecision === 'ALLOW') {
      mapped.push({
        service: 'firestore',
        kind: 'now-allowed',
        path: tc.path,
        method: tc.method,
        reason: testResult.notes.join('\n') || 'expected DENY, got ALLOW',
      });
    }
    return;
  }

  if (tc.expectation === 'DENY') {
    if (effectiveDecision === 'UNSUPPORTED') {
      mapped.push({
        service: 'firestore',
        kind: 'unsupported',
        path: tc.path,
        method: tc.method,
        reason: testResult.notes.join('\n') || 'unsupported write simulation',
      });
    } else if (effectiveDecision === 'ALLOW') {
      mapped.push({
        service: 'firestore',
        kind: 'now-allowed',
        path: tc.path,
        method: tc.method,
        reason: testResult.notes.join('\n') || 'expected DENY, got ALLOW',
      });
    }
    return;
  }

  if (tc.expectation === 'ALLOW' && effectiveDecision !== 'ALLOW') {
    const isTransientPath = !(tc.path in finalDocs) && !(tc.path in initialData);
    if (isTransientPath) {
      const stateDriftIdx = mapped.findIndex(
        (d) => d.path === tc.path && d.kind === 'state-drift',
      );
      if (stateDriftIdx >= 0) {
        mapped.splice(stateDriftIdx, 1);
      }
    }
    const hasExistingDivergence = mapped.some(
      (d) => d.path === tc.path && (d.kind === 'now-denied' || d.kind === 'unsupported'),
    );
    if (!hasExistingDivergence) {
      if (effectiveDecision === 'UNSUPPORTED') {
        mapped.push({
          service: 'firestore',
          kind: 'unsupported',
          path: tc.path,
          method: tc.method,
          reason: testResult.notes.join('\n') || 'unsupported write simulation',
        });
      } else {
        mapped.push({
          service: 'firestore',
          kind: 'now-denied',
          path: tc.path,
          method: tc.method,
          reason: testResult.notes.join('\n') || `expected ALLOW, got ${effectiveDecision}`,
        });
      }
    }
  }
}

function isProtectedFirestoreWrite(event: PyricVerifyFixture['events'][number]): boolean {
  return event.kind === 'write' && event.detail?.admin !== true;
}

function requireFirestoreRules(
  rules: FirestoreCandidateSource | undefined,
  missingMessage: string,
  database?: string,
): string {
  let source: string | undefined;
  if (typeof rules === 'string') {
    source = rules;
  } else if (rules && typeof rules.source === 'string') {
    source = rules.source;
  }
  if (source === undefined) {
    throw new VerifyInputError(missingMessage);
  }
  const scope = database === undefined ? '' : ` for database "${database}"`;
  if (source.trim().length === 0) {
    throw new VerifyInputError(`candidate Firestore rules${scope} would not deploy: empty rules source.`);
  }
  if (new TextEncoder().encode(source).length < 262_144) {
    const parsed = parseToASTOrError(source);
    if (
      parsed.ok &&
      parsed.ast.version === '2+modules' &&
      (parsed.ast.service === undefined || isFirestoreServiceName(parsed.ast.service.name))
    ) {
      const resolved = resolveModulesBrowser(source, { targetService: 'cloud.firestore' });
      if (!resolved.success) {
        if (!resolved.error.message.includes('requires basePath for relative imports')) {
          throw new VerifyInputError(
            `candidate Firestore rules${scope} would not deploy: Firestore rules module resolution failed (${resolved.error.code}): ${resolved.error.message}`,
          );
        }
      } else {
        source = resolved.data.resolved;
      }
    }
  }
  const rejection = rulesSourceRejection(source);
  if (rejection !== null) {
    throw new VerifyInputError(`candidate Firestore rules${scope} would not deploy: ${rejection.message}`);
  }
  return source;
}

function mapFirestoreDivergence(divergence: Divergence): VerifyDivergence {
  switch (divergence.kind) {
    case 'real-divergence':
      return {
        service: 'firestore',
        kind: 'state-drift',
        path: divergence.path,
        field: divergence.field,
        before: divergence.before,
        after: divergence.after,
      };
    case 'autoid-alias':
      return {
        service: 'firestore',
        kind: 'expected-drift',
        drift: 'autoid-alias',
        path: divergence.originalPath,
        before: divergence.originalPath,
        after: divergence.replayedPath,
      };
    case 'sentinel-drift':
      return {
        service: 'firestore',
        kind: 'expected-drift',
        drift: 'sentinel-drift',
        path: divergence.path,
        field: divergence.field,
        before: divergence.before,
        after: divergence.after,
      };
    case 'time-drift':
      return {
        service: 'firestore',
        kind: 'expected-drift',
        drift: 'time-drift',
        path: divergence.path,
        field: divergence.field,
        before: divergence.before,
        after: divergence.after,
      };
  }
}
