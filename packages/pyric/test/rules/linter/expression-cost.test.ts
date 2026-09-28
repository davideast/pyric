/**
 * EXPRESSION_BUDGET against production measurements.
 *
 * `fixtures/expression-cost/captures.json` holds, for 35 requests over four
 * rulesets, bounds on the expressions production's 1000-expression limit
 * counted (`production.cost`), captured by
 * `packages/conformance/src/capture-rules-expression-cost.ts`. The rulesets
 * sit beside it. The margins below are the linter's stated contract:
 *
 *  - never under: every estimate is at least production's lower bound;
 *  - where the rules fix the evaluated path (`pathFixed`), the estimate is
 *    within 10 percent above production's upper bound;
 *  - where the path depends on document values, the estimate is at most 6
 *    times production (measured: 1.03 to 5.25). The estimate is the most
 *    expensive path the rules allow for any document, and these requests
 *    take cheaper paths than that.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';
import { EXPRESSION_LIMIT, estimateExpressionCosts } from '../../../src/rules/linter/expression-cost.js';
import { lintFirestoreRules } from '../../../src/rules/linter/linter.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'expression-cost');

const FIXED_PATH_MARGIN = 1.1;
const DATA_DEPENDENT_MARGIN = 6;

interface RuleRef { matchPath: string; index: number }
interface CaptureCase {
  id: string;
  block: string;
  pathFixed: boolean;
  testCase: { method: string };
  production: { decision: string; grantingRule: RuleRef | null; limitReached: boolean; cost: { low: number; high: number | null } };
  simulator: { grantingRule: RuleRef | null };
}
interface CaptureSuite { id: string; rulesFile: string; rulesSha256: string; cases: CaptureCase[] }

const captures = JSON.parse(readFileSync(join(FIXTURES, 'captures.json'), 'utf8')) as { limit: number; suites: CaptureSuite[] };
const rulesOf = (suite: CaptureSuite) => readFileSync(join(FIXTURES, suite.rulesFile), 'utf8');

/** The estimate for the request a case made: the grant estimate of the rule
 *  that granted it (or, when production stopped the request early, the rule
 *  the simulator granted it with), else the block's deny estimate. */
function estimateFor(suite: CaptureSuite, c: CaptureCase): number {
  const estimates = estimateExpressionCosts(parseToAST(rulesOf(suite))!);
  const rule = c.production.grantingRule ?? c.simulator.grantingRule;
  if (rule) {
    const found = estimates.rules.find((r) => r.blockPath === rule.matchPath && r.blockRuleIndex === rule.index);
    if (!found || found.grantCost === null) throw new Error(`${c.id}: no grant estimate for ${JSON.stringify(rule)}`);
    return found.grantCost;
  }
  const block = estimates.blocks.find((b) => b.blockPath === c.block && b.method === c.testCase.method);
  if (!block) throw new Error(`${c.id}: no deny estimate for ${c.block} ${c.testCase.method}`);
  return block.denyCost;
}

describe('EXPRESSION_BUDGET estimate against production', () => {
  test('the fixture measures against the same limit the estimator uses', () => {
    expect(captures.limit).toBe(EXPRESSION_LIMIT);
  });

  for (const suite of captures.suites) {
    describe(suite.id, () => {
      test('the ruleset beside the fixture is the one production evaluated', () => {
        expect(createHash('sha256').update(rulesOf(suite)).digest('hex')).toBe(suite.rulesSha256);
      });

      for (const c of suite.cases) {
        test(`${c.id}: never under production, within the stated margin`, () => {
          const cost = estimateFor(suite, c);
          const { low, high } = c.production.cost;
          expect(cost).toBeGreaterThanOrEqual(low);
          const margin = c.pathFixed ? FIXED_PATH_MARGIN : DATA_DEPENDENT_MARGIN;
          expect(cost).toBeLessThanOrEqual(margin * (high ?? low));
        });
      }

      test('maxEstimatedExpressions covers every request production granted or stopped at the limit', () => {
        const metric = lintFirestoreRules(rulesOf(suite)).metrics.maxEstimatedExpressions;
        const granted = suite.cases.filter((c) => c.production.decision === 'ALLOW' || c.production.limitReached);
        for (const c of granted) expect(metric).toBeGreaterThanOrEqual(c.production.cost.low);
      });
    });
  }

  test('EXPRESSION_BUDGET warns on the chess rules, whose mating move production stopped at the limit', () => {
    const chess = captures.suites.find((s) => s.id === 'chess')!;
    expect(chess.cases.some((c) => c.production.limitReached)).toBe(true);
    const warnings = lintFirestoreRules(rulesOf(chess)).warnings.filter((w) => w.rule === 'EXPRESSION_BUDGET');
    expect(warnings.length).toBeGreaterThan(0);
    for (const w of warnings) {
      expect(w.severity).toBe('warning');
      expect(w.message).toMatch(/up to ~\d+ expressions/);
      expect(w.message).toContain(`${EXPRESSION_LIMIT}`);
    }
  });

  test('EXPRESSION_BUDGET warns on the arcade reversi move, which a three-ray capture already takes to three quarters of the limit', () => {
    const arcade = captures.suites.find((s) => s.id === 'arcade')!;
    const threeRays = arcade.cases.find((c) => c.id === 'arcade/reversi-three-rays')!;
    expect(threeRays.production.cost.low).toBeGreaterThan(0.75 * EXPRESSION_LIMIT);
    const warnings = lintFirestoreRules(rulesOf(arcade)).warnings.filter((w) => w.rule === 'EXPRESSION_BUDGET');
    expect(warnings.map((w) => w.location?.matchPath)).toEqual(['/reversi/{matchId}']);
  });

  test('EXPRESSION_BUDGET is silent where every estimate stays under the limit', () => {
    const ladder = captures.suites.find((s) => s.id === 'ladder')!;
    const result = lintFirestoreRules(rulesOf(ladder));
    expect(result.metrics.maxEstimatedExpressions).toBeLessThan(EXPRESSION_LIMIT);
    expect(result.warnings.filter((w) => w.rule === 'EXPRESSION_BUDGET')).toEqual([]);
  });
});

describe('expression cost model', () => {
  const estimate = (condition: string, functions = '') => {
    const source = `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /t/{id} {\n      ${functions}\n      allow get: if ${condition};\n    }\n  }\n}\n`;
    return estimateExpressionCosts(parseToAST(source)!).rules[0]!.grantCost;
  };

  test('counts literals and charges && one more when it evaluates its right operand', () => {
    // true(1) && true(1): 1 for the operator, 1 for evaluating the right side.
    expect(estimate('true && true')).toBe(4);
  });

  test('a let binding is evaluated when the function is called, read or not', () => {
    expect(estimate('f()', "function f() { let v = resource.data.a == 1; return true; }")).toBe(1 + (1 + 5) + 1);
  });

  test('a function call is paid on every call', () => {
    const once = estimate('f()', 'function f() { return resource.data.a == 1; }')!;
    expect(estimate('f() && f()', 'function f() { return resource.data.a == 1; }')).toBe(2 * once + 2);
  });

  test('an earlier rule whose equality gate the granting rule contradicts fails at its gate', () => {
    const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /t/{id} {
      allow update: if request.resource.data.kind == 'a' && request.resource.data.x == 1 && request.resource.data.y == 1;
      allow update: if request.resource.data.kind == 'b';
    }
  }
}
`;
    const [first, second] = estimateExpressionCosts(parseToAST(source)!).rules;
    // Gate: == (1) + request.resource.data.kind (4) + 'a' (1) = 6, plus the two
    // short-circuited && on the spine.
    expect(second!.grantCost).toBe(6 + 6 + 2);
    expect(first!.grantCost).toBeGreaterThan(second!.grantCost!);
  });

  test('a ternary pays 2 on its true branch and 4 on its false branch, and the estimate takes the more expensive', () => {
    // Condition `resource.data.a == 1` costs 5; each branch literal costs 1.
    // True branch: 2 + 5 + 1. False branch: 4 + 5 + 1.
    expect(estimate('resource.data.a == 1 ? true : true')).toBe(4 + 5 + 1);
    // A true branch 5 more expensive than the false one outweighs the false branch's 2.
    expect(estimate('resource.data.a == 1 ? (1 == 1 && true) : true')).toBe(2 + 5 + 6);
  });

  test('a rule whose own conjuncts contradict has no grant estimate', () => {
    expect(estimate("request.resource.data.kind == 'a' && request.resource.data.kind == 'b'")).toBeNull();
  });
});
