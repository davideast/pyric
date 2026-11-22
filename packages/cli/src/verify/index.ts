import type { EventService, SandboxOperationEvent } from 'pyric/sandbox';
import type { ExpressionReportLevel, TestResult } from 'pyric/rules/internal';
import { rtdbRulesSourceRejection, type RtdbRulesDocument } from 'pyric/rules/internal/rtdb';
import type { RtdbReplayDivergence } from 'pyric/sandbox/internal';
import type { StorageRequestMethod } from 'pyric/storage';
import type { bindRulesBucket } from 'pyric/storage/internal';

import type { ProjectScope } from '../credentials/core/types.js';
import {
  isRtdbRulesDocument,
  parseRtdbRulesJson,
  type RtdbRulesJson,
} from '../rtdb/rules-json.js';
import type { DeriveRulesTestCasesOptions, DeriveRulesTestCasesResult } from './cases.js';
import {
  fixtureVerifiableServices,
  parseVerifyFixture,
  type PyricVerifyFixture,
} from './fixture.js';
import { verifyFirestore } from './firestore-verify.js';
import {
  recordedRtdbInstances,
  recordsDefaultRtdbInstance,
  replayRtdbInstance,
} from './rtdb-instances.js';
import {
  runStagingInstance,
  StagingDeployRefusedError,
  withStagingInstance,
  type StagingRunHooks,
} from './staging/engine.js';
import type { RtdbRestClient } from './staging/rest.js';
import { verifyStorage } from './storage-verify.js';

export {
  buildVerifyFixture,
  fixtureVerifiableServices,
  parseVerifyFixture,
  restoreStorageRulesFromFixture,
  VERIFY_FIXTURE_SCHEMA,
  type BuildVerifyFixtureInput,
  type PyricVerifyFixture,
  type VerifyFirestoreDatabaseCapture,
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
  captureFirestoreDatabases,
  filterFixtureForFirestoreDatabase,
  firestoreEventDatabase,
  recordedFirestoreDatabases,
  recordsDefaultFirestoreDatabase,
} from './firestore-databases.js';
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
type StorageCandidateSource = string | { source: string };
type FirestoreCandidateSource = string | { source: string };

export type VerifyRulesInput = {
  firestore?: FirestoreCandidateSource;
  /**
   * Each named Firestore database's candidate rules, by the database id its
   * events carry. A recorded named database without an entry is not checked
   * and is listed in `skippedDatabases`.
   */
  firestoreDatabases?: Record<string, FirestoreCandidateSource>;
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
  /** Firestore: named databases the session used that no candidate rules were passed for. */
  skippedDatabases?: string[];
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
 * A divergence; a Firestore divergence on a named database names it in
 * `database`, an RTDB divergence on a named instance names it in `instance`,
 * and a Storage divergence names its bucket in `bucket`.
 */
export type VerifyDivergence = VerifyDivergenceKind & {
  database?: string;
  instance?: string;
  bucket?: string;
};

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
  const hasFirestoreCandidate =
    rules.firestore !== undefined ||
    (rules.firestoreDatabases !== undefined && Object.keys(rules.firestoreDatabases).length > 0);
  if (
    hasFirestoreCandidate &&
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
      services.firestore = await verifyFirestore(fixture, opts.rules, engines, opts);
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
    throw new VerifyInputError(
      'rulesTestApi verification is Firestore-only; select --service firestore or use the sandbox or staging engine for RTDB.',
    );
  }
  if (engines.includes('staging') && staging === undefined) {
    throw new VerifyInputError('the staging engine needs a staging instance (opts.staging).');
  }

  const checks: Array<{ instance?: string; rules: RtdbRulesJson; capturedState: unknown }> = [];
  const checksDefault = rules.rtdb !== undefined || recordsDefaultRtdbInstance(fixture);
  if (checksDefault) {
    checks.push({
      rules: requireRtdbRules(rules.rtdb, 'missing candidate RTDB rules. Pass rules.rtdb.'),
      capturedState: rtdb.state.tree,
    });
  }
  const skippedInstances: string[] = [];
  for (const instance of recordedRtdbInstances(fixture)) {
    const candidate = rules.rtdbInstances?.[instance];
    if (candidate === undefined) {
      skippedInstances.push(instance);
      continue;
    }
    const parsed = requireRtdbRules(
      candidate,
      `missing candidate RTDB rules for instance "${instance}".`,
      instance,
    );
    checks.push({ instance, rules: parsed, capturedState: rtdb.instances?.[instance]?.state.tree });
  }

  const engineResults: Partial<Record<VerifyEngine, VerifyEngineResult>> = {};
  if (engines.includes('sandbox')) {
    const replays = [];
    for (const check of checks) {
      replays.push(await replayRtdbInstance(fixture, check.rules, check.instance));
    }
    const divergences = replays.flatMap((replayed) =>
      replayed.divergences.map(mapRtdbReplayDivergence),
    );
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
  const serviceResult: VerifyServiceResult = {
    service: 'rtdb',
    ok: divergences.every(isInformational),
    checkedEvents:
      engineResults.sandbox?.checkedEvents ?? engineResults.staging?.checkedEvents ?? 0,
    divergences,
    engines: engineResults,
  };
  if (skippedInstances.length > 0) {
    serviceResult.skippedInstances = skippedInstances;
  }
  return serviceResult;
}

async function verifyRtdbOnStaging(
  fixture: PyricVerifyFixture,
  checks: Array<{ instance?: string; rules: RtdbRulesJson; capturedState: unknown }>,
  staging: NonNullable<VerifyFixtureOptions['staging']>,
): Promise<VerifyEngineResult> {
  const divergences: VerifyDivergence[] = [];
  let checkedEvents = 0;
  for (const check of checks) {
    try {
      const runInput: Parameters<typeof runStagingInstance>[0] = {
        client: staging.client,
        events: fixture.events,
        rules: check.rules,
        capturedState: check.capturedState,
      };
      if (check.instance !== undefined) runInput.instance = check.instance;
      if (staging.signal) runInput.signal = staging.signal;
      const { result } = await withStagingInstance(
        staging.client,
        staging.projectId,
        () => runStagingInstance(runInput),
        staging,
      );
      checkedEvents += result.checkedEvents;
      for (const divergence of result.divergences) {
        const entry: VerifyDivergence = { service: 'rtdb', ...divergence };
        if (check.instance !== undefined) entry.instance = check.instance;
        divergences.push(entry);
      }
    } catch (error) {
      if (!(error instanceof StagingDeployRefusedError)) throw error;
      const entry: VerifyDivergence = {
        service: 'rtdb',
        kind: 'unsupported',
        reason: error.message,
      };
      if (check.instance !== undefined) entry.instance = check.instance;
      divergences.push(entry);
    }
  }
  return { engine: 'staging', ok: divergences.every(isInformational), checkedEvents, divergences };
}

function addRtdbEngineDrift(sandbox: VerifyEngineResult, staging: VerifyEngineResult): void {
  const decisive = new Set(['now-denied', 'now-allowed', 'unsupported']);
  const keyOf = (divergence: VerifyDivergence) =>
    `${divergence.instance ?? ''}|${(divergence as { step?: number }).step ?? `${(divergence as { method?: string }).method}|${divergence.path}`}`;
  const byKey = (divergences: VerifyDivergence[]) =>
    new Map(
      divergences
        .filter((divergence) => decisive.has(divergence.kind))
        .map((divergence) => [keyOf(divergence), divergence]),
    );
  const local = byKey(sandbox.divergences);
  const remote = byKey(staging.divergences);
  for (const key of new Set([...local.keys(), ...remote.keys()])) {
    const sandboxKind = local.get(key)?.kind ?? 'unchanged';
    const stagingKind = remote.get(key)?.kind ?? 'unchanged';
    if (sandboxKind === stagingKind) continue;
    const sample = (local.get(key) ?? remote.get(key))!;
    const entry: VerifyDivergence & { step?: number } = {
      service: 'rtdb',
      kind: 'engine-drift',
      path: sample.path,
      method: (sample as { method?: string }).method,
      sandbox: sandboxKind,
      staging: stagingKind,
      reason: `the sandbox reported ${sandboxKind}; production reported ${stagingKind}.`,
    };
    if (sample.instance !== undefined) entry.instance = sample.instance;
    const sampleStep = (sample as { step?: number }).step;
    if (sampleStep !== undefined) entry.step = sampleStep;
    staging.divergences.push(entry);
  }
  staging.ok = staging.divergences.every(isInformational);
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

function requireRtdbRules(
  rules: RtdbCandidateRules | undefined,
  missing: string,
  instance?: string,
): RtdbRulesJson {
  let label = 'candidate RTDB rules';
  if (instance !== undefined) {
    label = `candidate RTDB rules for instance "${instance}"`;
  }
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

function mapRtdbReplayDivergence(
  divergence: RtdbReplayDivergence & { instance?: string },
): VerifyDivergence {
  return {
    service: 'rtdb',
    ...divergence,
  };
}

function isInformational(divergence: VerifyDivergence): boolean {
  return divergence.kind === 'expected-drift';
}

export function buildStorageVerifyRequest(
  auth: SandboxOperationEvent['auth'],
  method: string,
  objectPath: string,
  requestResource: Parameters<typeof bindRulesBucket>[0]['request']['resource'] | undefined,
): Parameters<typeof bindRulesBucket>[0]['request'] {
  const request: Parameters<typeof bindRulesBucket>[0]['request'] = {
    auth: auth ?? null,
    method: method as StorageRequestMethod,
    path: objectPath,
  };
  if (requestResource !== undefined) {
    request.resource = requestResource;
  }
  return request;
}
