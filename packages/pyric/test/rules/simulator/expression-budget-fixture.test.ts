/**
 * The simulator's expression count against production's measurements.
 *
 * `test/rules/linter/fixtures/expression-cost/captures.json` records, for 45
 * requests, the padding step at which production's 1000-expression limit
 * stopped the request: a padding rule evaluated first, whose cost grows with
 * `request.auth.token.pyric_pad`, is false below `threshold.at` and reaches
 * the limit at it (`packages/conformance/src/rules-expression-cost-pad.ts`).
 * So the request's own cost X satisfies
 *
 *   P(below) + X <= 1000 < P(at) + X
 *
 * where P(n) is the padding rule's cost. This test measures P(n) by running
 * the padding through the simulator, checks that it reproduces production's
 * six padding anchors, and then requires every request's simulated count to
 * lie in that window, which is 5 expressions wide. The window is computed
 * from the thresholds, not from the fixture's `production.cost`, which
 * carries the rounding of a linear fit of P(n).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PAD_SECOND_TOKEN,
  PAD_TOKEN,
  anchorRules,
  injectPadding,
} from '../../../../conformance/src/rules-expression-cost-pad.ts';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';
import { EXPRESSION_LIMIT, EXPRESSION_LIMIT_MESSAGE } from '../../../src/rules/simulator/expression-budget.js';
import type { TestCase, TestResult } from '../../../src/rules/test/spec.js';
import { firestoreRules } from '../../../src/rules/api/firestore.js';
import type { FirestoreCase } from '../../../src/rules/api/case-types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'linter', 'fixtures', 'expression-cost');
const REPO_ROOT = join(HERE, '..', '..', '..', '..', '..');

interface Threshold { below: number; at: number }
interface CaptureCase {
  id: string;
  block: string;
  testCase: TestCase;
  production: { decision: 'ALLOW' | 'DENY'; limitReached: boolean; threshold: Threshold; notes: string[] };
}
interface CaptureSuite {
  id: string;
  rulesFile: string;
  documents: Record<string, { file: string }>;
  cases: CaptureCase[];
}
interface Captures {
  limit: number;
  padding: { anchors: { second: number | null; threshold: Threshold }[] };
  suites: CaptureSuite[];
}

const captures = JSON.parse(readFileSync(join(FIXTURES, 'captures.json'), 'utf8')) as Captures;
const handler = new SimulateFirestoreRulesHandler();

/**
 * The count a request's padding threshold bounds. Production goes on to the
 * method's later allow rules after one raises an error, and counts them, but
 * when the limit is reached after that error it reports the error, not the
 * limit. The capture detects the limit by its message, so for a request with
 * an erroring rule the threshold bounds the count through the end of the
 * first rule that raised an error. arcade/chess-e4 is one: its move rule
 * raises "Unsupported operation error" (list + list), and the resign rule
 * after it (7 expressions) is evaluated but outside the measured window.
 */
function measuredCount(result: TestResult): number {
  const firstError = result.trace.find((t) => t.verdict === 'ERROR');
  return firstError?.evaluatedExpressions ?? result.evaluatedExpressions!;
}

function simulate(source: string, tc: TestCase, getDoc?: (path: string) => Record<string, unknown> | null): TestResult {
  const result = handler.simulate(source, [tc], getDoc ? { getDoc } : undefined);
  if (!result.success) throw new Error(result.error.message);
  return result.data.results[0]!;
}

function padded(tc: TestCase, token: Record<string, number>): TestCase {
  const auth = tc.auth ?? { uid: 'pyric-pad' };
  return { ...tc, auth: { ...auth, token: { ...(auth.token ?? {}), ...token } } };
}

const ANCHOR_RULES = anchorRules();
const ANCHOR_CASE: TestCase = {
  description: 'anchor', expectation: 'DENY', method: 'get', path: 'anchor-false/x', auth: { uid: 'pyric-pad' },
};

/** The padding rule's cost at step n: the anchor that follows it with
 *  `allow get: if false` costs P(n) + 1. */
function padCost(n: number): number {
  const r = simulate(ANCHOR_RULES, padded(ANCHOR_CASE, { [PAD_TOKEN]: n }));
  expect(r.resourceLimit).toBeUndefined();
  return r.evaluatedExpressions! - 1;
}

/** Production's window for the request's own cost, from its threshold. */
function windowOf(t: Threshold): { low: number; high: number } {
  return {
    low: EXPRESSION_LIMIT - padCost(t.at) + 1,
    high: t.below < 0 ? Infinity : EXPRESSION_LIMIT - padCost(t.below),
  };
}

describe('padding cost in the simulator', () => {
  test('the fixture measures against the limit the simulator enforces', () => {
    expect(captures.limit).toBe(EXPRESSION_LIMIT);
  });

  test('P(n) is 9 plus 5 per step plus 2 per 40-step segment', () => {
    for (const n of [0, 1, 39, 40, 41, 79, 80, 150]) {
      expect(padCost(n)).toBe(9 + 5 * n + 2 * Math.floor(n / 40));
    }
  });

  for (const { second, threshold } of captures.padding.anchors) {
    test(`anchor ${second === null ? 'padding then false' : `padding then padding(${second})`} reaches the limit where production did`, () => {
      const tc = second === null
        ? ANCHOR_CASE
        : { ...ANCHOR_CASE, path: 'anchor-pad/x' };
      const extra = second === null ? {} : { [PAD_SECOND_TOKEN]: second };
      const below = simulate(ANCHOR_RULES, padded(tc, { [PAD_TOKEN]: threshold.below, ...extra }));
      const at = simulate(ANCHOR_RULES, padded(tc, { [PAD_TOKEN]: threshold.at, ...extra }));
      expect(below.resourceLimit).toBeUndefined();
      expect(at.resourceLimit?.kind).toBe('expressions');
    });
  }
});

for (const suite of captures.suites) {
  describe(`expression count against production: ${suite.id}`, () => {
    const source = readFileSync(join(FIXTURES, suite.rulesFile), 'utf8');
    const documents: Record<string, Record<string, unknown>> = {};
    for (const [path, { file }] of Object.entries(suite.documents)) {
      documents[path] = JSON.parse(readFileSync(join(REPO_ROOT, file), 'utf8'));
    }
    const getDoc = (path: string) => documents[path.replace(/^\/+/, '')] ?? null;
    /** Stored function mocks name their document; the capture sent its data. */
    const resolved = (tc: TestCase): TestCase => tc.functionMocks
      ? {
        ...tc,
        functionMocks: tc.functionMocks.map((m) => {
          const ref = (m.result as { $document?: string } | undefined)?.$document;
          return ref ? { ...m, result: documents[ref] } : m;
        }),
      }
      : tc;

    for (const c of suite.cases) {
      const tc = resolved(c.testCase);
      const result = simulate(source, tc, getDoc);

      test(`${c.id}: decides as production did`, () => {
        expect(result.decision).toBe(c.production.decision);
        if (c.production.limitReached) {
          expect(result.resourceLimit).toMatchObject({ kind: 'expressions', limit: EXPRESSION_LIMIT, message: EXPRESSION_LIMIT_MESSAGE });
          expect(result.evaluatedExpressions).toBe(EXPRESSION_LIMIT);
        } else {
          expect(result.resourceLimit).toBeUndefined();
        }
      });

      if (c.production.limitReached) continue;

      test(`${c.id}: count lies in production's window`, () => {
        const { low, high } = windowOf(c.production.threshold);
        expect(high - low).toBeLessThanOrEqual(5);
        expect(measuredCount(result)).toBeGreaterThanOrEqual(low);
        expect(measuredCount(result)).toBeLessThanOrEqual(high);
      });

      test(`${c.id}: the padded request reaches the limit at production's step and not before`, () => {
        const withPadding = injectPadding(source, [{ anchor: `match ${c.block} {`, method: tc.method }]);
        const { below, at } = c.production.threshold;
        expect(simulate(withPadding, padded(tc, { [PAD_TOKEN]: below }), getDoc).resourceLimit).toBeUndefined();
        expect(simulate(withPadding, padded(tc, { [PAD_TOKEN]: at }), getDoc).resourceLimit?.kind).toBe('expressions');
      });
    }
  });
}

describe("the chess showcase's Fool's Mate", () => {
  // Black's queen d8 to h4 after f3 e5 g4, sent with moveType 'normal' to
  // the showcase rules as they stood before the showcase fix. Production
  // denied it at the limit; the simulator used to allow it.
  const chess = captures.suites.find((s) => s.id === 'chess')!;
  const mate = chess.cases.find((c) => c.id === 'chess/queen-mate')!;

  test('production stopped the request at the limit', () => {
    expect(mate.production.limitReached).toBe(true);
    expect(mate.testCase.data?.moveType).toBe('normal');
  });

  const source = readFileSync(join(FIXTURES, chess.rulesFile), 'utf8');
  const config = JSON.parse(readFileSync(join(REPO_ROOT, chess.documents['gameConfig/chessv2']!.file), 'utf8'));
  const tc = {
    ...mate.testCase,
    functionMocks: mate.testCase.functionMocks!.map((m) => ({ ...m, result: config })),
  };

  test('the simulator denies it at the limit with production\'s message', () => {
    const r = simulate(source, tc);
    expect(r.decision).toBe('DENY');
    expect(r.evaluatedExpressions).toBe(EXPRESSION_LIMIT);
    expect(r.resourceLimit?.message).toBe(EXPRESSION_LIMIT_MESSAGE);
    expect(r.trace.at(-1)!.verdict).toBe('ERROR');
  });

  // Production reported "firestore.rules line [135], column [1790]": inside
  // the move-validation function the update rules call, not at any allow
  // rule. The simulator counts about a dozen fewer expressions than
  // production before that point, so its budget runs out a few terms
  // later on the same line.
  const [, productionLine] = /line \[(\d+)\], column \[(\d+)\]/.exec(mate.production.notes.join(' '))!;

  test('the limit carries the line production reported and a column on it', () => {
    const r = simulate(source, tc);
    expect(r.resourceLimit?.line).toBe(Number(productionLine));
    expect(r.resourceLimit?.column).toBeGreaterThan(0);
    expect(r.notes.join(' ')).toContain(
      `line ${r.resourceLimit!.line}, column ${r.resourceLimit!.column}: ${EXPRESSION_LIMIT_MESSAGE}`,
    );
  });

  test('explain() cites the rule that reached the limit and where the budget ran out', () => {
    const explanation = firestoreRules(source).explain(tc as FirestoreCase);
    const limitRule = explanation.trace.at(-1)!;
    expect(limitRule.message).toBe(EXPRESSION_LIMIT_MESSAGE);
    // Not the first update rule, which denied before the limit was reached.
    expect(explanation.trace[0]!.line).not.toBe(limitRule.line);
    expect(explanation.deciding?.line).toBe(limitRule.line);
    expect(explanation.deciding?.verdict).toBe('deny');
    expect(explanation.resourceLimit?.line).toBe(Number(productionLine));
    expect(explanation.resourceLimit?.column).toBeGreaterThan(0);
  });
});
