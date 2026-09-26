import type { DocStore, DocumentData } from './local-state.js';
import type {
  SimulateFirestoreRulesHandler,
  TestCase,
  TestFirestoreRulesResult,
} from 'pyric/rules/internal';
import type { RulesState } from './rules-state.js';
import { adminBypassResult } from './rules-evaluation.js';

/**
 * Evaluate test cases against the deployed rules through the AST and
 * source map that {@link RulesState} caches per source, so a request does
 * not parse the ruleset. A source that does not parse goes through
 * `simulate(source)`, which reports the empty-source or parse failure.
 */
export function simulateDeployedRules(
  rules: RulesState,
  simulator: SimulateFirestoreRulesHandler,
  testCases: TestCase[],
  opts: Parameters<SimulateFirestoreRulesHandler['simulate']>[2],
): TestFirestoreRulesResult {
  const ast = rules.ast();
  if (!ast) return simulator.simulate(rules.source, testCases, opts);
  return simulator.simulateParsed(ast, rules.source, testCases, {
    ...opts,
    sourceMap: rules.sourceMap(),
  });
}

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
  return simulateDeployedRules(rules, simulator, testCases, {
    getDoc: (path) => state.get(path),
    ...(batchProjection ? { batchProjection } : {}),
  });
}
