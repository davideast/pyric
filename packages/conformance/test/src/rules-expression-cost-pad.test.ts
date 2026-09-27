import { describe, expect, test } from 'bun:test';
import { parseToAST } from '../../../pyric/src/rules/grammar/FirestoreParser.ts';
import { SimulateFirestoreRulesHandler } from '../../../pyric/src/rules/simulator/handler.ts';
import {
  EXPRESSION_LIMIT,
  PAD_MAX,
  PAD_TOKEN,
  costBounds,
  fitPadCost,
  injectPadding,
  isLimitMessage,
  nextCandidates,
  observe,
  padCost,
  type PadCostModel,
} from '../../src/rules-expression-cost-pad.ts';
import { expressionCostSuites } from '../../src/rules-expression-cost-suites.ts';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /a/{id} {
      allow get: if id == 'x';
    }
  }
}
`;

describe('padding injection', () => {
  test('adds the padding functions and a first rule to the anchored block', () => {
    const padded = injectPadding(RULES, [{ anchor: 'match /a/{id} {', method: 'get' }]);
    expect(parseToAST(padded)).not.toBeNull();
    const block = padded.slice(padded.indexOf('match /a/{id} {'));
    expect(block.indexOf(`request.auth.token.${PAD_TOKEN}`)).toBeLessThan(block.indexOf("id == 'x'"));
  });

  test('the padding rule is false for every step, so the request keeps its own decision', () => {
    const padded = injectPadding(RULES, [{ anchor: 'match /a/{id} {', method: 'get' }]);
    const simulator = new SimulateFirestoreRulesHandler();
    for (const n of [0, 57, PAD_MAX]) {
      const res = simulator.simulate(padded, [{
        description: `pad ${n}`, expectation: 'ALLOW', method: 'get', path: 'a/y', auth: { uid: 'u', token: { [PAD_TOKEN]: n } },
      }]);
      expect(res.success && res.data.results[0]!.decision).toBe('DENY');
    }
  });

  test('rejects an anchor that is missing or ambiguous', () => {
    expect(() => injectPadding(RULES, [{ anchor: 'match /b/{id} {', method: 'get' }])).toThrow('anchor not found');
    const twice = RULES.replace('match /a/{id} {', 'match /a/{id} {\n    }\n    match /a/{id} {');
    expect(() => injectPadding(twice, [{ anchor: 'match /a/{id} {', method: 'get' }])).toThrow('more than once');
  });

  test('every suite ruleset accepts its padding and still parses', () => {
    for (const suite of expressionCostSuites()) {
      const padded = injectPadding(suite.rules, suite.cases.map((c) => ({ anchor: c.padAnchor, method: c.testCase.method })));
      expect(parseToAST(padded)).not.toBeNull();
    }
  });
});

describe('padding model', () => {
  const model: PadCostModel = { base: 6, perStep: 5, perSegment: 5 };
  // Thresholds a model-exact production would report for padding followed by
  // a second padding of `second` steps: the smallest n whose total reaches 1000.
  const threshold = (second: number | null) => {
    const other = second === null ? 1 : padCost(model, second);
    let at = 0;
    while (padCost(model, at) + other < EXPRESSION_LIMIT) at++;
    return { below: at - 1, at };
  };

  test('recovers the model from anchor thresholds', () => {
    const anchors = [null, 0, 39, 100, 119, 159].map((second) => ({ second, threshold: threshold(second) }));
    const fit = fitPadCost(anchors);
    expect(fit.perStep).toBeCloseTo(model.perStep, 0);
    expect(Math.abs(fit.base - model.base)).toBeLessThan(model.perStep);
    expect(Math.abs(fit.perSegment - model.perSegment)).toBeLessThan(model.perStep);
  });

  test('bounds a cost between the paddings on either side of the threshold', () => {
    expect(costBounds(model, { below: 99, at: 100 })).toEqual({
      low: EXPRESSION_LIMIT - padCost(model, 100),
      high: EXPRESSION_LIMIT - padCost(model, 99),
    });
    expect(costBounds(model, { below: PAD_MAX, at: PAD_MAX + 1 })).toBeNull();
  });
});

describe('threshold search', () => {
  test('narrows to adjacent steps', () => {
    const truth = 137;
    let state = { below: -1, at: PAD_MAX + 1 };
    let rounds = 0;
    for (let candidates = nextCandidates(state, 5, 120); candidates.length > 0; candidates = nextCandidates(state, 5)) {
      for (const n of candidates) state = observe(state, n, n >= truth);
      rounds++;
    }
    expect(state).toEqual({ below: truth - 1, at: truth });
    expect(rounds).toBeLessThanOrEqual(4);
  });

  test('recognizes the limit message', () => {
    expect(isLimitMessage(['Error: firestore.rules line [5], column [9]. Unable to evaluate the expression as the maximum of 1000 expressions to evaluate has been reached.'])).toBe(true);
    expect(isLimitMessage(['Null value error.'])).toBe(false);
  });
});
