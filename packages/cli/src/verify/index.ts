import {
  replay as replayFirestore,
  type Divergence,
  type EventService,
  type SandboxOperationEvent,
  type ServiceMutationEvent,
} from 'pyric/sandbox';
import { evaluateStorageRules, type StorageRequestMethod } from 'pyric/storage';
import {
  compileStorageRules,
  DEFAULT_BUCKET,
  requestResourceFor,
  resourceFromStored,
  type StoredMetadata,
} from 'pyric/storage/internal';
import {
  rtdbRulesSourceRejection,
  type RtdbReplayDivergence,
  type RtdbRulesDocument,
} from 'pyric/rules/internal/rtdb';
import {
  SimulateFirestoreRulesHandler,
  type ExpressionReportLevel,
  type TestCase,
  type TestResult,
} from 'pyric/rules/internal';
import { executeHostedRulesTest } from './hosted-rules-test.js';
import type { ProjectScope } from '../credentials/core/types.js';
import {
  isRtdbRulesDocument,
  parseRtdbRulesJson,
  type RtdbRulesJson,
} from '../rtdb/rules-json.js';
import {
  fixtureVerifiableServices,
  parseVerifyFixture,
  VERIFY_FIXTURE_SCHEMA,
  type PyricVerifyFixture,
} from './fixture.js';
import {
  recordedRtdbInstances,
  recordsDefaultRtdbInstance,
  replayRtdbInstance,
} from './rtdb-instances.js';
import {
  deriveRulesTestCases,
  type DeriveRulesTestCasesOptions,
  type DeriveRulesTestCasesResult,
  type VerifyUnsupportedEvent,
} from './cases.js';

export {
  buildVerifyFixture,
  fixtureVerifiableServices,
  parseVerifyFixture,
  restoreStorageRulesFromFixture,
  VERIFY_FIXTURE_SCHEMA,
  type BuildVerifyFixtureInput,
  type PyricVerifyFixture,
  type VerifyFirestoreRulesBlock,
  type VerifyRtdbInstanceCapture,
  type VerifyRtdbRulesBlock,
  type VerifyStorageRulesBlock,
} from './fixture.js';
export {
  capturedDefaultRtdbInstance,
  recordedRtdbInstances,
  recordsDefaultRtdbInstance,
} from './rtdb-instances.js';
export {
  deriveRulesTestCases,
  type DerivedRulesTestCase,
  type DeriveRulesTestCasesOptions,
  type DeriveRulesTestCasesResult,
  type VerifyFixtureWarning,
  type VerifyUnsupportedEvent,
} from './cases.js';
export { createVerifyTools, type VerifyToolDeps } from './tools.js';
export {
  executeHostedRulesTest,
  HOSTED_CREDENTIAL_ENV_KEYS,
  HOSTED_CREDENTIAL_SOURCES,
  hostedRulesCredentials,
  isMissingCredentials,
  runHostedRulesTest,
  useHostedRulesTester,
  type HostedRulesCredentials,
  type HostedRulesScope,
  type HostedRulesTester,
  type HostedRulesTestOutcome,
  type MissingCredentials,
} from './hosted-rules-test.js';

export type VerifiableService = 'firestore' | 'rtdb' | 'storage';
export type VerifyEngine = 'sandbox' | 'rulesTestApi';

type RtdbCandidateRules = { rules: Record<string, unknown> } | RtdbRulesDocument;

export type VerifyRulesInput = {
  firestore?: string | { source: string };
  /** The default RTDB instance's candidate rules. */
  rtdb?: RtdbCandidateRules;
  /**
   * Each named RTDB instance's candidate rules, by the instance name its
   * events carry. A recorded instance without an entry is not checked, and
   * the result names it in `skippedInstances`.
   */
  rtdbInstances?: Record<string, RtdbCandidateRules>;
  storage?: string | { source: string };
};

export interface VerifyFixtureOptions {
  rules: VerifyRulesInput;
  services?: VerifiableService[];
  engines?: VerifyEngine[];
  rulesTestApi?: {
    scope: ProjectScope;
    expressionReportLevel?: ExpressionReportLevel;
  };
  caseDerivation?: Omit<DeriveRulesTestCasesOptions, 'service'>;
}

export interface VerifyResult {
  ok: boolean;
  services: Partial<Record<VerifiableService, VerifyServiceResult>>;
}

export interface VerifyServiceResult {
  service: VerifiableService;
  ok: boolean;
  checkedEvents: number;
  divergences: VerifyDivergence[];
  engines?: Partial<Record<VerifyEngine, VerifyEngineResult>>;
  /** RTDB: the named instances the session used that no candidate rules were passed for, so they were not checked. */
  skippedInstances?: string[];
}

export interface VerifyEngineResult {
  engine: VerifyEngine;
  ok: boolean;
  checkedEvents: number;
  divergences: VerifyDivergence[];
  testCases?: number;
  passed?: number;
  failed?: number;
  unsupported?: number;
  derivation?: DeriveRulesTestCasesResult;
  results?: TestResult[];
}

/** A divergence; an RTDB divergence on a named instance names it in `instance`. */
export type VerifyDivergence = VerifyDivergenceKind & { instance?: string };

type VerifyDivergenceKind =
  | {
      service: EventService | string;
      kind: 'now-denied';
      path?: string;
      method?: string;
      reason?: string;
    }
  | {
      service: EventService | string;
      kind: 'now-allowed';
      path?: string;
      method?: string;
      reason?: string;
    }
  | {
      service: EventService | string;
      kind: 'state-drift';
      path?: string;
      field?: string;
      before: unknown;
      after: unknown;
    }
  | {
      service: EventService | string;
      kind: 'unsupported';
      path?: string;
      method?: string;
      reason: string;
    }
  | {
      service: EventService | string;
      kind: 'expected-drift';
      drift: string;
      path?: string;
      field?: string;
      before?: unknown;
      after?: unknown;
    }
  | {
      service: EventService | string;
      kind: 'engine-drift';
      path?: string;
      method?: string;
      sandbox: string;
      rulesTestApi: string;
      reason?: string;
    };

export class VerifyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerifyInputError';
  }
}

export async function verifyFixture(
  fixtureInput: PyricVerifyFixture | unknown,
  opts: VerifyFixtureOptions,
): Promise<VerifyResult> {
  const fixture = parseVerifyFixture(fixtureInput);
  const selected = opts.services ?? fixtureVerifiableServices(fixture);
  const engines = normalizeEngines(opts.engines);
  if (selected.length === 0) {
    throw new VerifyInputError(
      `fixture ${fixture.schema} does not contain a verifiable rules service.`,
    );
  }

  const services: Partial<Record<VerifiableService, VerifyServiceResult>> = {};
  for (const service of selected) {
    if (service === 'firestore') {
      services.firestore = await verifyFirestore(fixture, requireFirestoreRules(opts.rules), engines, opts);
    } else if (service === 'rtdb') {
      services.rtdb = await verifyRtdb(fixture, opts.rules, engines);
    } else if (service === 'storage') {
      services.storage = await verifyStorage(fixture, opts.rules, engines);
    } else {
      const exhaustive: never = service;
      throw new VerifyInputError(`unsupported verify service: ${exhaustive}`);
    }
  }
  return {
    ok: Object.values(services).every((result) => result?.ok !== false),
    services,
  };
}

async function verifyFirestore(
  fixture: PyricVerifyFixture,
  rules: string,
  engines: VerifyEngine[],
  opts: VerifyFixtureOptions,
): Promise<VerifyServiceResult> {
  const firestore = fixture.services.firestore;
  if (!firestore) {
    throw new VerifyInputError('fixture does not contain services.firestore.');
  }

  const engineResults: Partial<Record<VerifyEngine, VerifyEngineResult>> = {};
  if (engines.includes('sandbox')) {
    engineResults.sandbox = verifyFirestoreSandbox(fixture, rules);
  }
  if (engines.includes('rulesTestApi')) {
    engineResults.rulesTestApi = await verifyFirestoreRulesTestApi(fixture, rules, opts);
  }
  if (engineResults.sandbox && engineResults.rulesTestApi) {
    addEngineDrift(rules, engineResults.rulesTestApi);
  }

  const divergences = collectEngineDivergences(engineResults);
  return {
    service: 'firestore',
    ok: divergences.every(isInformational),
    checkedEvents: serviceCheckedEvents(engineResults),
    divergences,
    engines: engineResults,
  };
}

function verifyFirestoreSandbox(
  fixture: PyricVerifyFixture,
  rules: string,
): VerifyEngineResult {
  const firestore = fixture.services.firestore;
  if (!firestore) {
    throw new VerifyInputError('fixture does not contain services.firestore.');
  }

  const { divergences } = replayFirestore(
    fixture.events,
    rules,
    {},
    firestore.state.documents,
  );
  const mapped = divergences.map(mapFirestoreDivergence);

  const readDerivation = deriveRulesTestCases(fixture, {
    service: 'firestore',
    includeListenerReads: true,
    mockReads: 'omit',
  });
  const readCases = readDerivation.testCases.filter(
    (tc) => tc.method === 'get' || tc.method === 'list',
  );
  if (readCases.length > 0) {
    const simulator = new SimulateFirestoreRulesHandler();
    const simulated = simulator.simulate(rules, readCases, {
      getDoc: (docPath) => firestore.state.documents[docPath] ?? null,
    });
    if (!simulated.success) {
      mapped.push({
        service: 'firestore',
        kind: 'unsupported',
        reason: simulated.error.message,
      });
    } else {
      for (const [index, testResult] of simulated.data.results.entries()) {
        const tc = readCases[index];
        const queryUnprovable =
          tc?.method === 'list' &&
          testResult.queryProof !== undefined &&
          !testResult.queryProof.provable;
        const effectiveDecision = queryUnprovable ? 'DENY' : testResult.decision;
        if (effectiveDecision === 'UNSUPPORTED') {
          mapped.push({
            service: 'firestore',
            kind: 'unsupported',
            path: tc?.path,
            method: tc?.method,
            reason: testResult.notes.join('\n') || 'unsupported read simulation',
          });
        } else if (tc?.expectation === 'ALLOW' && effectiveDecision !== 'ALLOW') {
          mapped.push({
            service: 'firestore',
            kind: 'now-denied',
            path: tc.path,
            method: tc.method,
            reason:
              testResult.queryProof?.reason ??
              (testResult.notes.join('\n') || `expected ALLOW, got ${effectiveDecision}`),
          });
        } else if (tc?.expectation === 'DENY' && effectiveDecision === 'ALLOW') {
          mapped.push({
            service: 'firestore',
            kind: 'now-allowed',
            path: tc.path,
            method: tc.method,
            reason: testResult.notes.join('\n') || 'expected DENY, got ALLOW',
          });
        }
      }
    }
  }

  return {
    engine: 'sandbox',
    ok: mapped.every(isInformational),
    checkedEvents: fixture.events.filter(isProtectedFirestoreWrite).length + readCases.length,
    divergences: mapped,
  };
}

function isProtectedFirestoreWrite(event: PyricVerifyFixture['events'][number]): boolean {
  return event.kind === 'write' && event.detail?.admin !== true;
}

async function verifyFirestoreRulesTestApi(
  fixture: PyricVerifyFixture,
  rules: string,
  opts: VerifyFixtureOptions,
): Promise<VerifyEngineResult> {
  const scope = opts.rulesTestApi?.scope;
  if (!scope) {
    throw new VerifyInputError('rulesTestApi verification requires rulesTestApi.scope.');
  }

  const derivation = deriveRulesTestCases(fixture, {
    service: 'firestore',
    includeListenerReads: false,
    ...opts.caseDerivation,
  });
  const divergences = derivation.unsupportedEvents.map(mapUnsupportedEvent);
  if (derivation.testCases.length === 0) {
    return {
      engine: 'rulesTestApi',
      ok: divergences.length === 0,
      checkedEvents: 0,
      testCases: 0,
      passed: 0,
      failed: 0,
      unsupported: divergences.length,
      derivation,
      divergences,
    };
  }

  const result = await executeHostedRulesTest(scope, rules, derivation.testCases, {
    expressionReportLevel: opts.rulesTestApi?.expressionReportLevel,
  });
  if (!result.success) {
    divergences.push({
      service: 'firestore',
      kind: 'unsupported',
      reason: `Rules Test API failed: ${result.error.message}`,
    });
    return {
      engine: 'rulesTestApi',
      ok: false,
      checkedEvents: 0,
      testCases: derivation.testCases.length,
      passed: 0,
      failed: derivation.testCases.length,
      unsupported: divergences.length,
      derivation,
      divergences,
    };
  }

  for (const [index, testResult] of result.data.results.entries()) {
    if (testResult.state !== 'FAILED') continue;
    const tc = derivation.testCases[index];
    divergences.push(mapFailedTestResult(testResult, tc));
  }

  return {
    engine: 'rulesTestApi',
    ok: divergences.every(isInformational),
    checkedEvents: result.data.results.length,
    testCases: derivation.testCases.length,
    passed: result.data.passed,
    failed: result.data.failed,
    unsupported: result.data.unsupported + derivation.unsupportedEvents.length,
    derivation,
    results: result.data.results,
    divergences,
  };
}

async function verifyRtdb(
  fixture: PyricVerifyFixture,
  rules: VerifyRulesInput,
  engines: VerifyEngine[],
): Promise<VerifyServiceResult> {
  const rtdb = fixture.services.rtdb;
  if (!rtdb) {
    throw new VerifyInputError('fixture does not contain services.rtdb.');
  }
  if (engines.includes('rulesTestApi')) {
    throw new VerifyInputError('rulesTestApi verification is Firestore-only; select --service firestore or use the sandbox engine for RTDB.');
  }

  const replays = [];
  const checksDefault = rules.rtdb !== undefined || recordsDefaultRtdbInstance(fixture);
  if (checksDefault) {
    replays.push(await replayRtdbInstance(fixture, requireRtdbRules(rules.rtdb, 'missing candidate RTDB rules. Pass rules.rtdb.')));
  }
  const skippedInstances: string[] = [];
  for (const instance of recordedRtdbInstances(fixture)) {
    const candidate = rules.rtdbInstances?.[instance];
    if (candidate === undefined) {
      skippedInstances.push(instance);
      continue;
    }
    const parsed = requireRtdbRules(candidate, `missing candidate RTDB rules for instance "${instance}".`, instance);
    replays.push(await replayRtdbInstance(fixture, parsed, instance));
  }

  const divergences = replays.flatMap((replayed) => replayed.divergences.map(mapRtdbReplayDivergence));
  const checkedEvents = replays.reduce((total, replayed) => total + replayed.checkedEvents, 0);
  const sandbox: VerifyEngineResult = {
    engine: 'sandbox',
    ok: divergences.every(isInformational),
    checkedEvents,
    divergences,
  };

  return {
    service: 'rtdb',
    ok: divergences.every(isInformational),
    checkedEvents,
    divergences,
    engines: { sandbox },
    ...(skippedInstances.length > 0 ? { skippedInstances } : {}),
  };
}

async function verifyStorage(
  fixture: PyricVerifyFixture,
  rules: VerifyRulesInput,
  engines: VerifyEngine[],
): Promise<VerifyServiceResult> {
  const storage = fixture.services.storage;
  if (!storage) {
    throw new VerifyInputError('fixture does not contain services.storage.');
  }
  if (engines.includes('rulesTestApi')) {
    throw new VerifyInputError(
      'rulesTestApi verification is Firestore-only; select --service firestore or use the sandbox engine for Storage.',
    );
  }

  const rulesSource = requireStorageRules(rules, fixture);
  let compiled;
  try {
    compiled = compileStorageRules(rulesSource);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new VerifyInputError(`candidate Storage rules would not deploy. ${message}`);
  }

  const objectState = new Map<string, StoredMetadata>();
  const seededKeys = new Set<string>();
  for (const event of fixture.events) {
    if (event.kind !== 'service_mutation' || event.service !== 'storage') continue;
    const mutation = event as ServiceMutationEvent;
    const bucket = storageMutationBucket(mutation);
    const key = `${bucket}/${(mutation.path ?? '').replace(/^\/+/, '')}`;
    if (!seededKeys.has(key)) {
      seededKeys.add(key);
      if (mutation.before && typeof mutation.before === 'object') {
        objectState.set(key, mutation.before as StoredMetadata);
      }
    }
  }

  const divergences: VerifyDivergence[] = [];
  let checkedEvents = 0;

  for (let i = 0; i < fixture.events.length; i++) {
    const event = fixture.events[i]!;
    if (event.kind === 'service_mutation' && event.service === 'storage') {
      const mutation = event as ServiceMutationEvent;
      const bucket = storageMutationBucket(mutation);
      const key = `${bucket}/${(mutation.path ?? '').replace(/^\/+/, '')}`;
      if (
        (mutation.op === 'object_put' || mutation.op === 'metadata_update') &&
        mutation.after &&
        typeof mutation.after === 'object'
      ) {
        objectState.set(key, mutation.after as StoredMetadata);
      } else if (mutation.op === 'object_delete') {
        objectState.delete(key);
      }
      continue;
    }

    if (event.kind !== 'operation' || event.service !== 'storage') continue;
    const opEvent = event as SandboxOperationEvent;
    if (opEvent.origin === 'admin' || opEvent.result === 'not-applicable') continue;
    checkedEvents += 1;

    const objectPath = (opEvent.path ?? '').replace(/^\/+/, '');
    let pairedMutation: ServiceMutationEvent | undefined;
    if (opEvent.result === 'allow' && isStorageWriteMethod(opEvent.method)) {
      for (let j = i + 1; j < fixture.events.length; j++) {
        const next = fixture.events[j]!;
        if (next.service !== 'storage') continue;
        if (next.kind === 'operation' && next.path === opEvent.path) break;
        if (next.kind === 'service_mutation' && next.path === opEvent.path) {
          pairedMutation = next as ServiceMutationEvent;
          break;
        }
      }
    }

    const bucket = pairedMutation ? storageMutationBucket(pairedMutation) : DEFAULT_BUCKET;
    const key = `${bucket}/${objectPath}`;
    const existing =
      pairedMutation && pairedMutation.before !== undefined
        ? (pairedMutation.before as StoredMetadata | undefined)
        : objectState.get(key);

    let requestResource;
    if (opEvent.method === 'create' || opEvent.method === 'write') {
      const after = pairedMutation?.after as StoredMetadata | undefined;
      requestResource = after
        ? requestResourceFor(after, 'upload')
        : requestResourceFor(
            {
              fullPath: objectPath,
              bucket,
              size: 0,
              contentType: 'application/octet-stream',
            },
            'upload',
          );
    } else if (opEvent.method === 'update') {
      const after = pairedMutation?.after as StoredMetadata | undefined;
      requestResource = after
        ? requestResourceFor(
            { ...after, metageneration: existing?.metageneration ?? after.metageneration },
            'metadataUpdate',
          )
        : requestResourceFor(
            {
              fullPath: objectPath,
              bucket,
              size: existing?.size ?? 0,
              contentType: existing?.contentType ?? 'application/octet-stream',
              generation: existing?.generation,
              metageneration: existing?.metageneration,
            },
            'metadataUpdate',
          );
    }

    const rulesPath = objectPath === '' ? `b/${bucket}/o` : `b/${bucket}/o/${objectPath}`;
    const evaluated = evaluateStorageRules(
      compiled.rules,
      {
        request: {
          auth: opEvent.auth ?? null,
          method: opEvent.method as StorageRequestMethod,
          path: rulesPath,
          ...(requestResource !== undefined ? { resource: requestResource } : {}),
        },
        resource: resourceFromStored(existing),
      },
      typeof opEvent.at === 'number' && Number.isFinite(opEvent.at)
        ? new Date(opEvent.at)
        : new Date(),
      fixture.services.firestore?.state?.documents
        ? {
            get: (docPath) => fixture.services.firestore?.state?.documents?.[docPath] ?? null,
            exists: (docPath) =>
              (fixture.services.firestore?.state?.documents?.[docPath] ?? null) !== null,
          }
        : undefined,
    );

    if (opEvent.result === 'allow' && !evaluated.allowed) {
      divergences.push({
        service: 'storage',
        kind: 'now-denied',
        path: opEvent.path,
        method: opEvent.method,
        reason: evaluated.reasons.join('; ') || 'expected ALLOW, got DENY',
      });
    } else if (opEvent.result === 'deny' && evaluated.allowed) {
      divergences.push({
        service: 'storage',
        kind: 'now-allowed',
        path: opEvent.path,
        method: opEvent.method,
        reason: evaluated.reasons.join('; ') || 'expected DENY, got ALLOW',
      });
    }
  }

  const sandbox: VerifyEngineResult = {
    engine: 'sandbox',
    ok: divergences.every(isInformational),
    checkedEvents,
    divergences,
  };

  return {
    service: 'storage',
    ok: divergences.every(isInformational),
    checkedEvents,
    divergences,
    engines: { sandbox },
  };
}

function isStorageWriteMethod(method: string | undefined): boolean {
  return method === 'create' || method === 'update' || method === 'delete' || method === 'write';
}

function storageMutationBucket(mutation: ServiceMutationEvent): string {
  const detailBucket = (mutation.detail as { bucket?: unknown } | undefined)?.bucket;
  if (typeof detailBucket === 'string' && detailBucket.length > 0) return detailBucket;
  const afterBucket = (mutation.after as { bucket?: unknown } | undefined)?.bucket;
  if (typeof afterBucket === 'string' && afterBucket.length > 0) return afterBucket;
  const beforeBucket = (mutation.before as { bucket?: unknown } | undefined)?.bucket;
  if (typeof beforeBucket === 'string' && beforeBucket.length > 0) return beforeBucket;
  return DEFAULT_BUCKET;
}

function normalizeEngines(input: VerifyEngine[] | undefined): VerifyEngine[] {
  const engines = input ?? ['sandbox'];
  const out: VerifyEngine[] = [];
  for (const engine of engines) {
    if (engine !== 'sandbox' && engine !== 'rulesTestApi') {
      throw new VerifyInputError(`unsupported verify engine: ${String(engine)}`);
    }
    if (!out.includes(engine)) out.push(engine);
  }
  return out.length > 0 ? out : ['sandbox'];
}

function collectEngineDivergences(
  engines: Partial<Record<VerifyEngine, VerifyEngineResult>>,
): VerifyDivergence[] {
  return Object.values(engines).flatMap((result) => result?.divergences ?? []);
}

function serviceCheckedEvents(
  engines: Partial<Record<VerifyEngine, VerifyEngineResult>>,
): number {
  return engines.sandbox?.checkedEvents ?? engines.rulesTestApi?.checkedEvents ?? 0;
}

function mapUnsupportedEvent(event: VerifyUnsupportedEvent): VerifyDivergence {
  return {
    service: event.service,
    kind: 'unsupported',
    path: event.path,
    method: event.method,
    reason: event.reason,
  };
}

function mapFailedTestResult(result: TestResult, tc: TestCase | undefined): VerifyDivergence {
  const path = tc?.path;
  const method = tc?.method;
  const reason = result.notes.join('\n') || `expected ${result.expectation}, got ${result.decision}`;
  if (result.expectation === 'ALLOW') {
    return {
      service: 'firestore',
      kind: 'now-denied',
      path,
      method,
      reason,
    };
  }
  return {
    service: 'firestore',
    kind: 'now-allowed',
    path,
    method,
    reason,
  };
}

function addEngineDrift(
  rules: string,
  rulesTestApi: VerifyEngineResult,
): void {
  const hostedCases = rulesTestApi.derivation?.testCases ?? [];
  if (hostedCases.length === 0) return;

  const simulator = new SimulateFirestoreRulesHandler();
  const local = simulator.simulate(rules, hostedCases);
  if (!local.success) return;

  for (const [index, localResult] of local.data.results.entries()) {
    const hostedResult = rulesTestApi.results?.[index];
    if (!hostedResult) continue;
    if (localResult.decision === hostedResult.decision) continue;
    const tc = hostedCases[index];
    rulesTestApi.divergences.push({
      service: 'firestore',
      kind: 'engine-drift',
      path: tc?.path,
      method: tc?.method,
      sandbox: localResult.decision,
      rulesTestApi: hostedResult.decision,
      reason: `sandbox decided ${localResult.decision}; Rules Test API decided ${hostedResult.decision}.`,
    });
  }
  rulesTestApi.ok = rulesTestApi.divergences.every(isInformational);
}

function requireFirestoreRules(input: VerifyRulesInput): string {
  const rules = input.firestore;
  if (typeof rules === 'string') return rules;
  if (rules && typeof rules.source === 'string') return rules.source;
  throw new VerifyInputError('missing candidate Firestore rules. Pass rules.firestore.');
}

function requireStorageRules(input: VerifyRulesInput, fixture: PyricVerifyFixture): string {
  const rules = input.storage;
  if (typeof rules === 'string') return rules;
  if (rules && typeof rules.source === 'string') return rules.source;
  const captured = fixture.services.storage?.rules?.source;
  if (typeof captured === 'string' && captured.length > 0) return captured;
  throw new VerifyInputError('missing candidate Storage rules. Pass rules.storage.');
}

function requireRtdbRules(
  rules: RtdbCandidateRules | undefined,
  missing: string,
  instance?: string,
): RtdbRulesJson {
  const label = instance === undefined ? 'candidate RTDB rules' : `candidate RTDB rules for instance "${instance}"`;
  let parsed: RtdbRulesJson;
  if (isRtdbRulesDocument(rules)) {
    parsed = parseRtdbRulesJson(
      rules.toJSON(),
      () => new VerifyInputError(`${label} document must compile to { rules: object }.`),
    );
  } else if (rules !== undefined) {
    parsed = parseRtdbRulesJson(
      rules,
      () => new VerifyInputError(`${label} must be { rules: object }.`),
    );
  } else {
    throw new VerifyInputError(missing);
  }
  const rejection = rtdbRulesSourceRejection(parsed);
  if (rejection !== null) {
    throw new VerifyInputError(`${label} would not deploy. ${rejection.message}`);
  }
  return parsed;
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

function mapRtdbReplayDivergence(divergence: RtdbReplayDivergence & { instance?: string }): VerifyDivergence {
  return {
    service: 'rtdb',
    ...divergence,
  };
}

function isInformational(divergence: VerifyDivergence): boolean {
  return divergence.kind === 'expected-drift';
}
