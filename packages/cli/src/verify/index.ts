import {
  replay as replayFirestore,
  type Divergence,
  type EventService,
  type SandboxOperationEvent,
  type ServiceMutationEvent,
  type WriteSandboxEvent,
} from 'pyric/sandbox';
import { evaluateStorageRules, type StorageRequestMethod } from 'pyric/storage';
import {
  bindRulesBucket,
  compileStorageRules,
  DEFAULT_BUCKET,
  normalizeRecordedStorageDeniedWrite,
  type CompiledStorageRules,
  requestResourceFor,
  resourceFromStored,
  rulesBucketName,
  type StoredMetadata,
} from 'pyric/storage/internal';
import { rtdbRulesSourceRejection, type RtdbRulesDocument } from 'pyric/rules/internal/rtdb';
import {
  applyUnescapedUserMapPaths,
  decodeSnapshotMapForEnv,
  isProductionServed,
  observedMethod,
  productionVerdict,
  type RtdbReplayDivergence,
} from 'pyric/sandbox/internal';
import type { ObservedCall } from 'pyric/sandbox';
import { definedOnly } from '../serve/worker/host/observe-local-evaluation.js';
import { evaluateFirestoreCall, type FirestoreSimulate } from '../serve/worker/host/observe-local-firestore.js';
import {
  parseToASTOrError,
  resolveModulesBrowser,
  rulesSourceRejection,
  SimulateFirestoreRulesHandler,
  Timestamp,
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
  type VerifyObservedCallValues,
} from './fixture.js';
import { runStagingInstance, StagingDeployRefusedError, withStagingInstance, type StagingRunHooks } from './staging/engine.js';
import type { RtdbRestClient } from './staging/rest.js';
import {
  recordedRtdbInstances,
  recordsDefaultRtdbInstance,
  replayRtdbInstance,
} from './rtdb-instances.js';
import {
  lockedBucketReason,
  recordedBucketName,
  storageBucketRules,
  type StorageBucketRules,
  type StorageCandidateRuleset,
} from './storage-buckets.js';
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
  type VerifyObservedCallValues,
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
export type VerifyEngine = 'sandbox' | 'rulesTestApi' | 'staging';

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
  /** The default bucket's candidate Storage rules, or every bucket's when `storageBuckets` is absent. */
  storage?: StorageCandidateSource;
  /**
   * Each bucket's candidate Storage rules, by the bucket name its rules see.
   * Passing it replays each bucket under its own rules; a recorded bucket
   * without an entry, other than the default bucket, replays as locked.
   */
  storageBuckets?: Record<string, StorageCandidateSource>;
};

type StorageCandidateSource = string | { source: string };

export interface VerifyFixtureOptions {
  rules: VerifyRulesInput;
  services?: VerifiableService[];
  engines?: VerifyEngine[];
  rulesTestApi?: {
    scope: ProjectScope;
    expressionReportLevel?: ExpressionReportLevel;
  };
  caseDerivation?: Omit<DeriveRulesTestCasesOptions, 'service'>;
  /**
   * The staging engine's instance: a client for a dedicated RTDB instance
   * enrolled with `pyric verify staging init`, and the project it is
   * enrolled for. Required when `engines` includes `staging`.
   */
  staging?: { client: RtdbRestClient; projectId: string } & StagingRunHooks;
}

export interface VerifyResult {
  ok: boolean;
  services: Partial<Record<VerifiableService, VerifyServiceResult>>;
}

export interface VerifyUnevaluatedEvent {
  eventId: string;
  path?: string;
  method?: string;
  bucket?: string;
  needs: string[];
  reason: string;
}

export interface VerifyServiceResult {
  service: VerifiableService;
  ok: boolean;
  checkedEvents: number;
  divergences: VerifyDivergence[];
  engines?: Partial<Record<VerifyEngine, VerifyEngineResult>>;
  /** RTDB: the named instances the session used that no candidate rules were passed for, so they were not checked. */
  skippedInstances?: string[];
  /** Events skipped because captured bindings were redacted and candidate rules read those fields. */
  unevaluatedEvents?: VerifyUnevaluatedEvent[];
  /** Informational notes describing skipped or unevaluated events that did not produce divergences. */
  notes?: string[];
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
  unevaluatedEvents?: VerifyUnevaluatedEvent[];
  notes?: string[];
}

/**
 * A divergence; an RTDB divergence on a named instance names it in
 * `instance`, and a Storage divergence names its bucket in `bucket`.
 */
export type VerifyDivergence = VerifyDivergenceKind & { instance?: string; bucket?: string };

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
      /** Firestore: the hosted Rules Test API's decision. */
      rulesTestApi?: string;
      /** RTDB: what production did on the staging instance. */
      staging?: string;
      reason?: string;
    };

export class VerifyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerifyInputError';
  }
}

function defaultSelectedServices(
  fixture: PyricVerifyFixture,
  rules: VerifyRulesInput,
): VerifiableService[] {
  const services = fixtureVerifiableServices(fixture);
  if (
    rules.firestore !== undefined &&
    fixture.services.firestore &&
    !services.includes('firestore')
  ) {
    return ['firestore', ...services];
  }
  return services;
}

export async function verifyFixture(
  fixtureInput: PyricVerifyFixture | unknown,
  opts: VerifyFixtureOptions,
): Promise<VerifyResult> {
  const fixture = parseVerifyFixture(fixtureInput);
  const selected = opts.services ?? defaultSelectedServices(fixture, opts.rules);
  const engines = normalizeEngines(opts.engines);
  if (selected.length === 0) {
    throw new VerifyInputError(
      `fixture ${fixture.schema} does not contain a verifiable rules service.`,
    );
  }

  const services: Partial<Record<VerifiableService, VerifyServiceResult>> = {};
  for (const service of selected) {
    if (engines.includes('staging') && service !== 'rtdb') {
      throw new VerifyInputError(
        `the staging engine checks RTDB only; ${service} is not supported by it yet. Select --service rtdb, or the sandbox engine for ${service}.`,
      );
    }
    if (service === 'firestore') {
      services.firestore = await verifyFirestore(fixture, requireFirestoreRules(opts.rules), engines, opts);
    } else if (service === 'rtdb') {
      services.rtdb = await verifyRtdb(fixture, opts.rules, engines, opts.staging);
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

  const { divergences } = replayFirestore(
    seedWrites.length > 0 ? [...seedWrites, ...fixture.events] : fixture.events,
    rules,
    {},
    decodedFinalDocuments,
  );
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
    const resolvedTime = tc.requestTime ? Timestamp.fromIsoString(tc.requestTime) : Timestamp.fromMillis(Date.now());
    proj.set(
      tc.path,
      tc.method === 'delete' || tc.data === undefined
        ? null
        : (resolveProjectedServerTimestamps(tc.data, resolvedTime) as Record<string, unknown>),
    );
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
      } else if (tc.expectation === 'DENY') {
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
      } else if (tc.expectation === 'ALLOW' && effectiveDecision !== 'ALLOW') {
        const isTransientPath =
          !(tc.path in firestore.state.documents) && !(tc.path in initialData);
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

/** A live client Firestore call's event: production served it under Security Rules, and it named a path. */
function isLiveFirestoreCall(event: PyricVerifyFixture['events'][number]): event is SandboxOperationEvent & { path: string } {
  if (event.kind !== 'operation' || event.service !== 'firestore') return false;
  const operation = event as SandboxOperationEvent;
  if (
    operation.origin === 'admin' ||
    operation.rulesDisposition?.kind === 'bypassed' ||
    operation.detail?.sdk === 'admin'
  ) {
    return false;
  }
  return isProductionServed(operation.rulesDisposition) && operation.production !== undefined && typeof operation.path === 'string';
}

function observedAccountOf(uid: string | undefined, claimNames: string[] | undefined, claims: Record<string, unknown> | undefined): ObservedCall['account'] {
  if (uid === undefined) return undefined;
  return definedOnly({ uid, claimNames, claims });
}

function observedQueryOf(raw: unknown): ObservedCall['query'] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const scope = (raw as { scope?: unknown }).scope;
  if (scope !== 'collection' && scope !== 'collection-group') return undefined;
  return raw as ObservedCall['query'];
}

/** A captured live call as the host observed it: its event, with the values the capture kept beside it. */
function observedCallOf(event: SandboxOperationEvent & { path: string }, values: VerifyObservedCallValues | undefined): ObservedCall {
  return definedOnly({
    service: 'firestore', method: event.method, path: event.path, at: event.at, outcome: event.production!.outcome,
    account: observedAccountOf(event.auth?.uid, event.production?.claimNames, values?.claims),
    query: observedQueryOf(event.request?.query),
    writeData: values?.writeData, document: values?.document,
  });
}

/**
 * Replay each live Firestore call the capture holds against the candidate
 * rules, the way the host evaluated it (`evaluateFirestoreCall`), and report
 * each one the rules now answer differently from production: a call
 * production allowed is `now-denied`, one it denied is `now-allowed`. A
 * call whose answer rests on data the capture lacks (a stored document, the
 * written data, a claim's value, a query), and a call production failed for
 * another reason, is not checked.
 */
function verifyLiveFirestoreCalls(fixture: PyricVerifyFixture, rules: string): { checkedEvents: number; divergences: VerifyDivergence[] } {
  const simulator = new SimulateFirestoreRulesHandler();
  const simulate: FirestoreSimulate = (cases, lookups) => simulator.simulate(rules, cases, lookups);
  const divergences: VerifyDivergence[] = [];
  let checkedEvents = 0;
  for (const event of fixture.events.filter(isLiveFirestoreCall)) {
    const method = observedMethod('firestore', event.method);
    const verdict = productionVerdict(event.production!.outcome);
    if (method === null || verdict === 'failed') continue;
    const evaluation = evaluateFirestoreCall(simulate, observedCallOf(event, fixture.observedCalls?.[event.id]), method, undefined, rules);
    const isDecided = evaluation !== undefined && evaluation.needs.length === 0;
    if (!isDecided) continue;
    const allowed = evaluation.allowed;
    checkedEvents += 1;
    const productionAllowed = verdict === 'ok';
    if (allowed === productionAllowed) continue;
    divergences.push({
      service: 'firestore',
      kind: productionAllowed ? 'now-denied' : 'now-allowed',
      path: event.path,
      method,
      reason: productionAllowed ? 'production allowed this live call; the local rules deny it' : 'production denied this live call; the local rules allow it',
    });
  }
  return { checkedEvents, divergences };
}

function decodeCapturedFirestoreDoc(
  docData: Record<string, unknown>,
  unescapedPaths?: readonly (readonly (string | number)[])[],
): Record<string, unknown> {
  const stamped = applyUnescapedUserMapPaths(docData, unescapedPaths);
  return decodeSnapshotMapForEnv(stamped);
}

function decodeCapturedFirestoreDocStore(
  docs: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [docPath, docData] of Object.entries(docs)) {
    Object.defineProperty(out, docPath, {
      value: decodeSnapshotMapForEnv(docData),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function reconstructInitialFirestoreDocuments(
  fixture: PyricVerifyFixture,
  predecodedFinalDocs?: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const firestore = fixture.services.firestore;
  if (!firestore) return {};
  const finalDocs = predecodedFinalDocs ?? decodeCapturedFirestoreDocStore(firestore.state.documents);
  const firstSeenState = new Map<string, Record<string, unknown> | null>();
  for (const event of fixture.events) {
    if (event.kind === 'request') {
      const service = (event as { service?: unknown }).service;
      if (service !== undefined && service !== 'firestore') continue;
      if (!firstSeenState.has(event.path) && event.resourceBefore !== undefined) {
        let beforeDoc: Record<string, unknown> | null = null;
        if (event.resourceBefore.exists && event.resourceBefore.data !== null) {
          beforeDoc = decodeCapturedFirestoreDoc(
            event.resourceBefore.data,
            event.resourceBefore.unescapedPaths,
          );
        }
        firstSeenState.set(event.path, beforeDoc);
      }
    } else if (event.kind === 'write') {
      if (!firstSeenState.has(event.path)) {
        let priorDoc: Record<string, unknown> | null = null;
        if (event.priorState !== null) {
          priorDoc = decodeCapturedFirestoreDoc(event.priorState, event.priorUnescapedPaths);
        }
        firstSeenState.set(event.path, priorDoc);
      }
    }
  }
  const initialData: Record<string, Record<string, unknown>> = {};
  for (const [docPath, docData] of firstSeenState.entries()) {
    if (docData !== null) {
      Object.defineProperty(initialData, docPath, {
        value: docData,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  for (const [docPath, docData] of Object.entries(finalDocs)) {
    if (!firstSeenState.has(docPath)) {
      Object.defineProperty(initialData, docPath, {
        value: docData,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return initialData;
}

function buildPointInTimeFirestoreDocs(
  fixture: PyricVerifyFixture,
  initialData: Record<string, Record<string, unknown>>,
): Map<string, Record<string, Record<string, unknown>>> {
  const currentDocs: Record<string, Record<string, unknown>> = { ...initialData };
  const preGroupDocs = new Map<string, Record<string, Record<string, unknown>>>();
  const docsByEventId = new Map<string, Record<string, Record<string, unknown>>>();
  for (const event of fixture.events) {
    const groupId = (event as { groupId?: unknown }).groupId;
    if (typeof groupId === 'string' && !preGroupDocs.has(groupId)) {
      preGroupDocs.set(groupId, { ...currentDocs });
    }
    if (event.kind === 'request') {
      const snapshot = typeof groupId === 'string' ? preGroupDocs.get(groupId)! : currentDocs;
      docsByEventId.set(event.id, { ...snapshot });
    } else if (event.kind === 'write') {
      if (event.nextState === null || event.method === 'delete') {
        delete currentDocs[event.path];
      } else {
        Object.defineProperty(currentDocs, event.path, {
          value: decodeCapturedFirestoreDoc(event.nextState, event.nextUnescapedPaths),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
  }
  return docsByEventId;
}

function isPlainProjectedObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function resolveProjectedServerTimestamps(value: unknown, serverTime: Timestamp): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => resolveProjectedServerTimestamps(item, serverTime));
  }
  if (value === null || typeof value !== 'object') return value;
  const unescapedTag = Symbol.for('pyric.unescapedMap');
  const isUnescaped = (value as Record<symbol, unknown>)[unescapedTag] === true;
  const rec = value as Record<string, unknown>;
  if (
    !isUnescaped &&
    (rec.__type === 'serverTimestamp' ||
      rec._methodName === 'serverTimestamp' ||
      rec._methodName === 'FieldValue.serverTimestamp')
  ) {
    return serverTime;
  }
  if (!isPlainProjectedObject(value)) return value;
  if (
    !isUnescaped &&
    Object.keys(rec).length === 2 &&
    Object.hasOwn(rec, 'type') &&
    rec.type === 'pyric/map/1.0' &&
    isPlainProjectedObject(rec.fields)
  ) {
    const fieldsOut: Record<string, unknown> = {};
    for (const [fk, fv] of Object.entries(rec.fields)) {
      Object.defineProperty(fieldsOut, fk, {
        value: resolveProjectedServerTimestamps(fv, serverTime),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return { type: 'pyric/map/1.0', fields: fieldsOut };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    Object.defineProperty(out, k, {
      value: resolveProjectedServerTimestamps(v, serverTime),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  if (isUnescaped) {
    Object.defineProperty(out, unescapedTag, { value: true });
  }
  return out;
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
  staging: VerifyFixtureOptions['staging'],
): Promise<VerifyServiceResult> {
  const rtdb = fixture.services.rtdb;
  if (!rtdb) {
    throw new VerifyInputError('fixture does not contain services.rtdb.');
  }
  if (engines.includes('rulesTestApi')) {
    throw new VerifyInputError('rulesTestApi verification is Firestore-only; select --service firestore or use the sandbox or staging engine for RTDB.');
  }
  if (engines.includes('staging') && staging === undefined) {
    throw new VerifyInputError('the staging engine needs a staging instance (opts.staging).');
  }

  // The instances to check, each with its candidate rules.
  const checks: Array<{ instance?: string; rules: RtdbRulesJson; capturedState: unknown }> = [];
  const checksDefault = rules.rtdb !== undefined || recordsDefaultRtdbInstance(fixture);
  if (checksDefault) {
    checks.push({ rules: requireRtdbRules(rules.rtdb, 'missing candidate RTDB rules. Pass rules.rtdb.'), capturedState: rtdb.state.tree });
  }
  const skippedInstances: string[] = [];
  for (const instance of recordedRtdbInstances(fixture)) {
    const candidate = rules.rtdbInstances?.[instance];
    if (candidate === undefined) {
      skippedInstances.push(instance);
      continue;
    }
    const parsed = requireRtdbRules(candidate, `missing candidate RTDB rules for instance "${instance}".`, instance);
    checks.push({ instance, rules: parsed, capturedState: rtdb.instances?.[instance]?.state.tree });
  }

  const engineResults: Partial<Record<VerifyEngine, VerifyEngineResult>> = {};
  if (engines.includes('sandbox')) {
    const replays = [];
    for (const check of checks) replays.push(await replayRtdbInstance(fixture, check.rules, check.instance));
    const divergences = replays.flatMap((replayed) => replayed.divergences.map(mapRtdbReplayDivergence));
    engineResults.sandbox = {
      engine: 'sandbox',
      ok: divergences.every(isInformational),
      checkedEvents: replays.reduce((total, replayed) => total + replayed.checkedEvents, 0),
      divergences,
    };
  }
  if (engines.includes('staging') && staging !== undefined) {
    engineResults.staging = await verifyRtdbOnStaging(fixture, checks, staging);
  }
  if (engineResults.sandbox && engineResults.staging) {
    addRtdbEngineDrift(engineResults.sandbox, engineResults.staging);
  }

  const divergences = collectEngineDivergences(engineResults);
  return {
    service: 'rtdb',
    ok: divergences.every(isInformational),
    checkedEvents: engineResults.sandbox?.checkedEvents ?? engineResults.staging?.checkedEvents ?? 0,
    divergences,
    engines: engineResults,
    ...(skippedInstances.length > 0 ? { skippedInstances } : {}),
  };
}

/**
 * Replay each instance on the staging instance in turn, each run guarded and
 * the instance put back before the next. Production refusing to deploy an
 * instance's candidate rules is reported for that instance; the others run.
 */
async function verifyRtdbOnStaging(
  fixture: PyricVerifyFixture,
  checks: Array<{ instance?: string; rules: RtdbRulesJson; capturedState: unknown }>,
  staging: NonNullable<VerifyFixtureOptions['staging']>,
): Promise<VerifyEngineResult> {
  const divergences: VerifyDivergence[] = [];
  let checkedEvents = 0;
  for (const check of checks) {
    const tag = check.instance === undefined ? {} : { instance: check.instance };
    try {
      const { result } = await withStagingInstance(staging.client, staging.projectId, () =>
        runStagingInstance({
          client: staging.client,
          events: fixture.events,
          rules: check.rules,
          capturedState: check.capturedState,
          ...(check.instance === undefined ? {} : { instance: check.instance }),
          ...(staging.signal ? { signal: staging.signal } : {}),
        }), staging);
      checkedEvents += result.checkedEvents;
      divergences.push(...result.divergences.map((divergence) => ({ service: 'rtdb', ...divergence, ...tag })));
    } catch (error) {
      if (!(error instanceof StagingDeployRefusedError)) throw error;
      divergences.push({ service: 'rtdb', kind: 'unsupported', reason: error.message, ...tag });
    }
  }
  return { engine: 'staging', ok: divergences.every(isInformational), checkedEvents, divergences };
}

/**
 * Where the sandbox and production decided a captured step differently: one
 * engine reports `now-denied`, `now-allowed` or `unsupported` for a step and
 * the other reports something else, or nothing. Steps are matched by their
 * index in the replay both engines walk.
 */
function addRtdbEngineDrift(sandbox: VerifyEngineResult, staging: VerifyEngineResult): void {
  const decisive = new Set(['now-denied', 'now-allowed', 'unsupported']);
  const keyOf = (divergence: VerifyDivergence) =>
    `${divergence.instance ?? ''}|${(divergence as { step?: number }).step ?? `${(divergence as { method?: string }).method}|${divergence.path}`}`;
  const byKey = (divergences: VerifyDivergence[]) =>
    new Map(divergences.filter((divergence) => decisive.has(divergence.kind)).map((divergence) => [keyOf(divergence), divergence]));
  const local = byKey(sandbox.divergences);
  const remote = byKey(staging.divergences);
  for (const key of new Set([...local.keys(), ...remote.keys()])) {
    const sandboxKind = local.get(key)?.kind ?? 'unchanged';
    const stagingKind = remote.get(key)?.kind ?? 'unchanged';
    if (sandboxKind === stagingKind) continue;
    const sample = (local.get(key) ?? remote.get(key))!;
    staging.divergences.push({
      service: 'rtdb',
      kind: 'engine-drift',
      path: sample.path,
      method: (sample as { method?: string }).method,
      sandbox: sandboxKind,
      staging: stagingKind,
      reason: `the sandbox reported ${sandboxKind}; production reported ${stagingKind}.`,
      ...(sample.instance === undefined ? {} : { instance: sample.instance }),
      ...((sample as { step?: number }).step === undefined ? {} : { step: (sample as { step?: number }).step }),
    });
  }
  staging.ok = staging.divergences.every(isInformational);
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

  const ruleset = storageCandidateRuleset(rules, fixture);

  const objectState = new Map<string, StoredMetadata>();
  const seededKeys = new Set<string>();
  const knownBuckets = new Set<string>();
  for (const event of fixture.events) {
    if (event.service !== 'storage') continue;
    if (event.kind === 'operation') {
      const opBucket = storageOperationBucket(event as SandboxOperationEvent);
      if (opBucket) knownBuckets.add(opBucket);
      continue;
    }
    if (event.kind !== 'service_mutation') continue;
    const mutation = event as ServiceMutationEvent;
    const bucket = storageMutationBucket(mutation);
    knownBuckets.add(bucket);
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
  const consumedMutationIndices = new Set<number>();
  const currentFirestoreDocs: Record<string, Record<string, unknown>> = {
    ...reconstructInitialFirestoreDocuments(fixture),
  };

  for (let i = 0; i < fixture.events.length; i++) {
    const event = fixture.events[i]!;
    if (event.kind === 'write') {
      if (event.nextState === null || event.method === 'delete') {
        delete currentFirestoreDocs[event.path];
      } else {
        Object.defineProperty(currentFirestoreDocs, event.path, {
          value: decodeCapturedFirestoreDoc(event.nextState, event.nextUnescapedPaths),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      continue;
    }
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
    // A call production served was decided by production's rules, not the captured ones.
    const isUnchecked = opEvent.origin === 'admin' || opEvent.result === 'not-applicable' || isProductionServed(opEvent.rulesDisposition);
    if (isUnchecked) continue;

    const objectPath = (opEvent.path ?? '').replace(/^\/+/, '');
    const opBucket = storageOperationBucket(opEvent);
    let pairedMutation: ServiceMutationEvent | undefined;
    if (opEvent.result === 'allow' && isStorageWriteMethod(opEvent.method)) {
      for (let j = i + 1; j < fixture.events.length; j++) {
        if (consumedMutationIndices.has(j)) continue;
        const next = fixture.events[j]!;
        if (next.service !== 'storage') continue;
        if (next.kind !== 'operation' && next.kind !== 'service_mutation') continue;
        const nextPath = (next.path ?? '').replace(/^\/+/, '');
        if (nextPath !== objectPath) continue;
        if (next.kind === 'operation') {
          const nextOp = next as SandboxOperationEvent;
          const nextBucket = storageOperationBucket(nextOp);
          const sameBucket =
            opBucket === undefined || nextBucket === undefined || nextBucket === opBucket;
          if (
            sameBucket &&
            nextOp.result === 'allow' &&
            isStorageWriteMethod(nextOp.method) &&
            nextOp.method !== opEvent.method
          ) {
            break;
          }
          continue;
        }
        if (next.kind === 'service_mutation') {
          const candidate = next as ServiceMutationEvent;
          const mutBucket = storageMutationBucket(candidate);
          if (opBucket !== undefined && mutBucket !== opBucket) continue;
          if (!isMatchingStorageMutationOp(opEvent.method, candidate.op)) {
            break;
          }
          pairedMutation = candidate;
          consumedMutationIndices.add(j);
          break;
        }
      }
    }

    const bucket = resolveStorageOperationBucket(
      opEvent,
      pairedMutation,
      objectPath,
      objectState,
      knownBuckets,
    );
    const key = `${bucket}/${objectPath}`;
    const existing =
      pairedMutation && pairedMutation.before !== undefined
        ? (pairedMutation.before as StoredMetadata | undefined)
        : objectState.get(key);
    const rawDeniedWrite =
      fixture.storageDeniedWrites !== undefined &&
      Object.hasOwn(fixture.storageDeniedWrites, opEvent.id)
        ? fixture.storageDeniedWrites[opEvent.id]
        : undefined;
    const deniedWrite = normalizeRecordedStorageDeniedWrite(rawDeniedWrite);
    const detailRequestResource = deniedWrite?.requestResource;
    const detailResource = deniedWrite?.resource;

    // The rules saw the bucket under the name the live op recorded.
    const bucketName = recordedBucketName(opEvent, bucket);
    const bucketRules = storageBucketRules(ruleset, bucket, bucketName);

    checkedEvents += 1;

    let requestResource;
    if (opEvent.method === 'create' || opEvent.method === 'write') {
      const after = pairedMutation?.after as StoredMetadata | undefined;
      requestResource = after
        ? requestResourceFor(after, 'upload')
        : (detailRequestResource ??
          requestResourceFor(
            {
              fullPath: objectPath,
              bucket,
              size: 0,
              contentType: 'application/octet-stream',
            },
            'upload',
          ));
    } else if (opEvent.method === 'update') {
      const after = pairedMutation?.after as StoredMetadata | undefined;
      requestResource = after
        ? requestResourceFor(
            { ...after, metageneration: existing?.metageneration ?? after.metageneration },
            'metadataUpdate',
          )
        : (detailRequestResource ??
          requestResourceFor(
            {
              fullPath: objectPath,
              bucket,
              size: existing?.size ?? detailResource?.size ?? 0,
              contentType: existing?.contentType ?? detailResource?.contentType ?? 'application/octet-stream',
              generation:
                existing?.generation ??
                (detailResource?.generation !== undefined ? String(detailResource.generation) : undefined),
              metageneration:
                existing?.metageneration ??
                (detailResource?.metageneration !== undefined
                  ? String(detailResource.metageneration)
                  : undefined),
            },
            'metadataUpdate',
          ));
    }

    const input = bindRulesBucket(
      {
        request: {
          auth: opEvent.auth ?? null,
          method: opEvent.method as StorageRequestMethod,
          path: objectPath,
          ...(requestResource !== undefined ? { resource: requestResource } : {}),
        },
        resource: existing ? resourceFromStored(existing) : (detailResource ?? null),
      },
      bucket,
      bucketName,
    );
    const evaluated = evaluateReplayedStorageRequest(
      bucketRules,
      input,
      opEvent,
      fixture,
      currentFirestoreDocs,
    );

    if (opEvent.result === 'allow' && !evaluated.allowed) {
      divergences.push({
        service: 'storage',
        kind: 'now-denied',
        bucket: bucketName,
        path: opEvent.path,
        method: opEvent.method,
        reason: evaluated.reasons.join('; ') || 'expected ALLOW, got DENY',
      });
    } else if (opEvent.result === 'deny' && evaluated.allowed) {
      divergences.push({
        service: 'storage',
        kind: 'now-allowed',
        bucket: bucketName,
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

/** Evaluate one replayed request under its bucket's rules; a locked bucket denies it. */
function evaluateReplayedStorageRequest(
  bucketRules: StorageBucketRules,
  input: Parameters<typeof evaluateStorageRules>[1],
  opEvent: SandboxOperationEvent,
  fixture: PyricVerifyFixture,
  pointInTimeFirestoreDocs: Record<string, Record<string, unknown>>,
): { allowed: boolean; reasons: string[] } {
  if (bucketRules.kind === 'locked') return { allowed: false, reasons: [lockedBucketReason(bucketRules.bucket)] };
  const hasRecordedTime = typeof opEvent.at === 'number' && Number.isFinite(opEvent.at);
  const requestTime = hasRecordedTime ? new Date(opEvent.at) : new Date();
  return evaluateStorageRules(
    bucketRules.rules,
    input,
    requestTime,
    fixtureFirestoreLookup(fixture, pointInTimeFirestoreDocs),
  );
}

function readOwnDocument(
  docs: Record<string, Record<string, unknown>>,
  docPath: string,
): Record<string, unknown> | null {
  if (!Object.hasOwn(docs, docPath)) return null;
  return docs[docPath] ?? null;
}

/** The captured Firestore documents a Storage rule's `firestore.get()` / `firestore.exists()` reads. */
function fixtureFirestoreLookup(
  _fixture: PyricVerifyFixture,
  pointInTimeFirestoreDocs: Record<string, Record<string, unknown>>,
): Parameters<typeof evaluateStorageRules>[3] {
  return {
    get: (docPath) => readOwnDocument(pointInTimeFirestoreDocs, docPath),
    exists: (docPath) => readOwnDocument(pointInTimeFirestoreDocs, docPath) !== null,
  };
}

function isStorageWriteMethod(method: string | undefined): boolean {
  return method === 'create' || method === 'update' || method === 'delete' || method === 'write';
}

function isMatchingStorageMutationOp(
  method: string | undefined,
  mutationOp: string | undefined,
): boolean {
  if (method === 'create') return mutationOp === 'object_put';
  if (method === 'update') return mutationOp === 'metadata_update';
  if (method === 'delete') return mutationOp === 'object_delete';
  if (method === 'write') {
    return (
      mutationOp === 'object_put' ||
      mutationOp === 'metadata_update' ||
      mutationOp === 'object_delete'
    );
  }
  return false;
}

function storageOperationBucket(opEvent: SandboxOperationEvent): string | undefined {
  const directBucket = (opEvent as { bucket?: unknown }).bucket;
  if (typeof directBucket === 'string' && directBucket.length > 0) return directBucket;
  const detailBucket = (opEvent.detail as { bucket?: unknown } | undefined)?.bucket;
  if (typeof detailBucket === 'string' && detailBucket.length > 0) return detailBucket;
  return undefined;
}

function resolveStorageOperationBucket(
  opEvent: SandboxOperationEvent,
  pairedMutation: ServiceMutationEvent | undefined,
  objectPath: string,
  objectState: ReadonlyMap<string, StoredMetadata>,
  knownBuckets: ReadonlySet<string>,
): string {
  const opBucket = storageOperationBucket(opEvent);
  if (opBucket) return opBucket;
  if (pairedMutation) return storageMutationBucket(pairedMutation);
  const matchingBuckets: string[] = [];
  for (const candidateBucket of knownBuckets) {
    if (objectState.has(`${candidateBucket}/${objectPath}`)) {
      matchingBuckets.push(candidateBucket);
    }
  }
  if (matchingBuckets.length === 1) return matchingBuckets[0]!;
  if (knownBuckets.size === 1) return [...knownBuckets][0]!;
  return DEFAULT_BUCKET;
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
    if (engine !== 'sandbox' && engine !== 'rulesTestApi' && engine !== 'staging') {
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
  return engines.sandbox?.checkedEvents ?? engines.rulesTestApi?.checkedEvents ?? engines.staging?.checkedEvents ?? 0;
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
  let source =
    typeof rules === 'string'
      ? rules
      : rules && typeof rules.source === 'string'
        ? rules.source
        : undefined;
  if (source === undefined) {
    throw new VerifyInputError('missing candidate Firestore rules. Pass rules.firestore.');
  }
  if (source.trim().length === 0) {
    throw new VerifyInputError('candidate Firestore rules would not deploy: empty rules source.');
  }
  if (new TextEncoder().encode(source).length < 262_144) {
    const parsed = parseToASTOrError(source);
    if (
      parsed.ok &&
      parsed.ast.version === '2+modules' &&
      (parsed.ast.service === undefined || parsed.ast.service.name === 'cloud.firestore')
    ) {
      const resolved = resolveModulesBrowser(source, { targetService: 'cloud.firestore' });
      if (!resolved.success) {
        if (!resolved.error.message.includes('requires basePath for relative imports')) {
          throw new VerifyInputError(
            `candidate Firestore rules would not deploy: Firestore rules module resolution failed (${resolved.error.code}): ${resolved.error.message}`,
          );
        }
      } else {
        source = resolved.data.resolved;
      }
    }
  }
  const rejection = rulesSourceRejection(source);
  if (rejection !== null) {
    throw new VerifyInputError(`candidate Firestore rules would not deploy: ${rejection.message}`);
  }
  return source;
}

/** The default rules passed, else the rules the capture recorded. */
function defaultStorageRulesSource(input: VerifyRulesInput, fixture: PyricVerifyFixture): string | undefined {
  const passed = storageSourceText(input.storage);
  if (passed !== undefined) return passed;
  const captured = fixture.services.storage?.rules?.source;
  const hasCaptured = typeof captured === 'string' && captured.length > 0;
  return hasCaptured ? captured : undefined;
}

function storageSourceText(rules: StorageCandidateSource | undefined): string | undefined {
  if (typeof rules === 'string') return rules;
  if (rules && typeof rules.source === 'string') return rules.source;
  return undefined;
}

/** Compile each bucket's candidate Storage rules; a source that would not deploy refuses the run. */
function storageCandidateRuleset(input: VerifyRulesInput, fixture: PyricVerifyFixture): StorageCandidateRuleset {
  const defaultSource = defaultStorageRulesSource(input, fixture);
  const byBucket = input.storageBuckets;
  if (defaultSource === undefined && byBucket === undefined) {
    throw new VerifyInputError('missing candidate Storage rules. Pass rules.storage.');
  }
  const defaultRules = defaultSource === undefined ? undefined : compileCandidateStorageRules(defaultSource);
  if (byBucket === undefined) return { ...(defaultRules === undefined ? {} : { defaultRules }) };
  const buckets = new Map<string, CompiledStorageRules['rules']>();
  for (const [rawBucket, rules] of Object.entries(byBucket)) {
    const bucket = rulesBucketName(rawBucket, rawBucket);
    if (buckets.has(bucket)) {
      throw new VerifyInputError(`duplicate candidate Storage rules for bucket "${bucket}".`);
    }
    const source = storageSourceText(rules);
    if (source === undefined) throw new VerifyInputError(`missing candidate Storage rules for bucket "${rawBucket}".`);
    buckets.set(bucket, compileCandidateStorageRules(source, bucket));
  }
  return { ...(defaultRules === undefined ? {} : { defaultRules }), buckets };
}

function compileCandidateStorageRules(source: string, bucket?: string): CompiledStorageRules['rules'] {
  try {
    return compileStorageRules(source).rules;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const scope = bucket === undefined ? '' : ` for bucket "${bucket}"`;
    throw new VerifyInputError(`candidate Storage rules${scope} would not deploy. ${message}`);
  }
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
