/**
 * Live-call replay and hosted `rulesTestApi` verification helpers for `verify/firestore-verify.ts`.
 */
import type { ObservedCall, SandboxOperationEvent } from 'pyric/sandbox';
import {
  SimulateFirestoreRulesHandler,
  type TestCase,
  type TestResult,
} from 'pyric/rules/internal';
import {
  isProductionServed,
  observedMethod,
  productionVerdict,
} from 'pyric/sandbox/internal';

import { definedOnly } from '../serve/worker/host/observe-local-evaluation.js';
import {
  evaluateFirestoreCall,
  type FirestoreSimulate,
} from '../serve/worker/host/observe-local-firestore.js';
import { deriveRulesTestCases, type VerifyUnsupportedEvent } from './cases.js';
import type { PyricVerifyFixture, VerifyObservedCallValues } from './fixture.js';
import { executeHostedRulesTest } from './hosted-rules-test.js';
import {
  VerifyInputError,
  type VerifyDivergence,
  type VerifyEngineResult,
  type VerifyFixtureOptions,
} from './index.js';

function isInformational(divergence: VerifyDivergence): boolean {
  return divergence.kind === 'expected-drift';
}

function isLiveFirestoreCall(
  event: PyricVerifyFixture['events'][number],
): event is SandboxOperationEvent & { path: string } {
  if (event.kind !== 'operation' || event.service !== 'firestore') return false;
  const operation = event as SandboxOperationEvent;
  if (
    operation.origin === 'admin' ||
    operation.rulesDisposition?.kind === 'bypassed' ||
    operation.detail?.sdk === 'admin'
  ) {
    return false;
  }
  return (
    isProductionServed(operation.rulesDisposition) &&
    operation.production !== undefined &&
    typeof operation.path === 'string'
  );
}

function observedAccountOf(
  uid: string | undefined,
  claimNames: string[] | undefined,
  claims: Record<string, unknown> | undefined,
): ObservedCall['account'] {
  if (uid === undefined) return undefined;
  return definedOnly({ uid, claimNames, claims });
}

function observedQueryOf(raw: unknown): ObservedCall['query'] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const scope = (raw as { scope?: unknown }).scope;
  if (scope !== 'collection' && scope !== 'collection-group') return undefined;
  return raw as ObservedCall['query'];
}

function observedCallOf(
  event: SandboxOperationEvent & { path: string },
  values: VerifyObservedCallValues | undefined,
): ObservedCall {
  return definedOnly({
    service: 'firestore',
    method: event.method,
    path: event.path,
    at: event.at,
    outcome: event.production!.outcome,
    account: observedAccountOf(event.auth?.uid, event.production?.claimNames, values?.claims),
    query: observedQueryOf(event.request?.query),
    writeData: values?.writeData,
    document: values?.document,
  });
}

export function verifyLiveFirestoreCalls(
  fixture: PyricVerifyFixture,
  rules: string,
): { checkedEvents: number; divergences: VerifyDivergence[] } {
  const simulator = new SimulateFirestoreRulesHandler();
  const simulate: FirestoreSimulate = (cases, lookups) => simulator.simulate(rules, cases, lookups);
  const divergences: VerifyDivergence[] = [];
  let checkedEvents = 0;
  for (const event of fixture.events.filter(isLiveFirestoreCall)) {
    const method = observedMethod('firestore', event.method);
    const verdict = productionVerdict(event.production!.outcome);
    if (method === null || verdict === 'failed') continue;
    const evaluation = evaluateFirestoreCall(
      simulate,
      observedCallOf(event, fixture.observedCalls?.[event.id]),
      method,
      undefined,
      rules,
    );
    const isDecided = evaluation !== undefined && evaluation.needs.length === 0;
    if (!isDecided) continue;
    const allowed = evaluation.allowed;
    checkedEvents += 1;
    const productionAllowed = verdict === 'ok';
    if (allowed === productionAllowed) continue;
    let kind: 'now-denied' | 'now-allowed' = 'now-allowed';
    let reason = 'production denied this live call; the local rules allow it';
    if (productionAllowed) {
      kind = 'now-denied';
      reason = 'production allowed this live call; the local rules deny it';
    }
    divergences.push({
      service: 'firestore',
      kind,
      path: event.path,
      method,
      reason,
    });
  }
  return { checkedEvents, divergences };
}

export async function verifyFirestoreRulesTestApi(
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

export function addEngineDrift(rules: string, rulesTestApi: VerifyEngineResult): void {
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
