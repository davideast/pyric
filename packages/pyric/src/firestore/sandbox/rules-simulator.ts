import type { DocStore, DocumentData } from './local-state.js';
import type {
  SimulateFirestoreRulesHandler,
  TestCase,
  TestFirestoreRulesResult,
} from 'pyric/rules/internal';
import type { RulesState } from './rules-state.js';
import { adminBypassResult } from './rules-evaluation.js';

/** Shared read/write invocation policy for the Firestore rules simulator. */
export function simulateRules(
  state: DocStore,
  rules: RulesState,
  simulator: SimulateFirestoreRulesHandler,
  testCases: TestCase[],
  bypassRules: boolean | undefined,
  batchProjection?: Map<string, DocumentData | null>,
): TestFirestoreRulesResult {
  if (bypassRules) {
    const results = testCases.map((testCase) => adminBypassResult(testCase.description));
    return {
      success: true,
      data: { passed: results.length, failed: 0, unsupported: 0, results },
    };
  }
  return simulator.simulate(rules.source, testCases, {
    getDoc: (path) => state.get(path),
    ...(batchProjection ? { batchProjection } : {}),
  });
}
