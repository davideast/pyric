/**
 * Recorded verdicts against a candidate ruleset.
 *
 * A capture holds what the rules decided at the time each request was made.
 * `deriveRulesTestCases` turns those requests into Rules Test API cases whose
 * expectation is the recorded verdict, and the local simulator decides each
 * case again under the candidate rules. The pair is what a divergence is: the
 * verdict the recording holds and the verdict the candidate reaches.
 *
 * Two methods read this. `verifyCases` reports every case and its pair, and
 * `replaySession` reports only the pairs that disagree, alongside the state
 * divergences the replay engine found.
 */
import { SimulateFirestoreRulesHandler, type TestCase, type TestResult } from 'pyric/rules/internal';

import { deriveRulesTestCases, type PyricVerifyFixture } from '../../verify/index.js';

/** A verdict, in the vocabulary the event log and the surface both use. */
export type Verdict = 'allow' | 'deny' | 'unsupported';

/** One recorded request, the verdict it carries, and the verdict the candidate reaches. */
export interface CaseVerdict {
  path: string;
  method: string;
  description: string;
  /** The verdict the capture holds for this request. */
  recorded: Verdict;
  /** The verdict the candidate rules reach for the same request. */
  candidate: Verdict;
  /** Whether the two agree. */
  agrees: boolean;
  /** What the engine said about the decision, when it said anything. */
  notes: string[];
}

/** Every derived case with its verdict pair, and the counts a summary reads. */
export interface CaseRun {
  cases: CaseVerdict[];
  agreed: number;
  diverged: number;
  /** Recorded requests the derivation could not turn into a case, with the reason. */
  unsupportedEvents: Array<{ path?: string; method?: string; reason: string }>;
}

/** Why a case run produced nothing, in the caller's words. */
export interface CaseRunFailure {
  error: string;
}

/** The verdict a Rules Test API expectation states. */
function recordedVerdict(testCase: TestCase): Verdict {
  return testCase.expectation === 'ALLOW' ? 'allow' : 'deny';
}

/** The verdict one local simulation reached. */
function candidateVerdict(result: TestResult): Verdict {
  if (result.decision === 'ALLOW') return 'allow';
  if (result.decision === 'DENY') return 'deny';
  return 'unsupported';
}

/**
 * Derive the cases one capture holds and decide each of them under the
 * candidate rules. Returns the pairs, or the reason the engine produced none.
 */
export function runDerivedCases(
  fixture: PyricVerifyFixture,
  rules: string,
): CaseRun | CaseRunFailure {
  const derivation = deriveRulesTestCases(fixture, { service: 'firestore' });
  const unsupportedEvents = derivation.unsupportedEvents.map((event) => ({
    path: event.path,
    method: event.method,
    reason: event.reason,
  }));
  if (derivation.testCases.length === 0) {
    return {
      cases: [],
      agreed: 0,
      diverged: 0,
      unsupportedEvents,
    };
  }

  const simulated = new SimulateFirestoreRulesHandler().simulate(rules, derivation.testCases);
  if (!simulated.success) return { error: simulated.error.message };

  const cases: CaseVerdict[] = [];
  for (const [index, result] of simulated.data.results.entries()) {
    const testCase = derivation.testCases[index];
    if (testCase === undefined) continue;
    const recorded = recordedVerdict(testCase);
    const candidate = candidateVerdict(result);
    cases.push({
      path: testCase.path,
      method: testCase.method,
      description: testCase.description,
      recorded,
      candidate,
      agrees: recorded === candidate,
      notes: result.notes,
    });
  }
  return {
    cases,
    agreed: cases.filter((entry) => entry.agrees).length,
    diverged: cases.filter((entry) => !entry.agrees).length,
    unsupportedEvents,
  };
}
