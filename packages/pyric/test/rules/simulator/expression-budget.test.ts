/**
 * The Firestore simulator's per-request expression budget.
 *
 * Production stops a request once it has evaluated 1000 expressions and
 * denies it with "Unable to evaluate the expression as the maximum of 1000
 * expressions to evaluate has been reached." The simulator counts in the
 * same unit (see src/rules/simulator/expression-budget.ts) across every
 * allow rule and match block the request reaches, reports the count as
 * `evaluatedExpressions`, and denies with `resourceLimit` once the limit is
 * passed. `expression-budget-fixture.test.ts` checks the unit against
 * production's measurements.
 */
import { describe, expect, test } from 'bun:test';
import { firestoreRules } from '../../../src/rules/index.js';
import { parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';
import { evaluate, type SimulationContext } from '../../../src/rules/simulator/evaluator.js';
import { ExpressionLimitError } from '../../../src/rules/simulator/eval-error.js';
import {
  EXPRESSION_LIMIT,
  EXPRESSION_LIMIT_MESSAGE,
  ExpressionBudget,
} from '../../../src/rules/simulator/expression-budget.js';
import type { TestCase } from '../../../src/rules/test/spec.js';

const handler = new SimulateFirestoreRulesHandler();

function rules(body: string, functions = ''): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    ${functions}
    ${body}
  }
}`;
}

const GET: TestCase = {
  description: 'get',
  expectation: 'ALLOW',
  method: 'get',
  path: 't/x',
  auth: { uid: 'u' },
  resource: { a: 1, s: 'abc' },
};

function run(source: string, tc: TestCase = GET) {
  const result = handler.simulate(source, [tc]);
  if (!result.success) throw new Error(result.error.message);
  return result.data.results[0]!;
}

/** Expressions one `allow get` condition evaluates in match /t/{id}. */
function cost(condition: string, functions = ''): number {
  return run(rules(`match /t/{id} { allow get: if ${condition}; }`, functions)).evaluatedExpressions!;
}

/** `n` copies of `true` joined by `&&`: n literals plus 2 per operator. */
const trues = (n: number) => Array.from({ length: n }, () => 'true').join(' && ');

describe('expression budget unit', () => {
  test('every evaluated node costs 1, literals included', () => {
    expect(cost('true')).toBe(1);
    // ==, resource, .data, .a, 1
    expect(cost('resource.data.a == 1')).toBe(5);
  });

  test('&& and || cost 1, plus 1 when they evaluate their right operand', () => {
    expect(cost('true && true')).toBe(4);
    expect(cost('false && true')).toBe(2);
    expect(cost('true || false')).toBe(2);
    expect(cost('false || true')).toBe(4);
  });

  test('a ternary costs 2 on its true branch and 4 on its false branch, plus the condition and the branch', () => {
    expect(cost('true ? true : false')).toBe(4);
    expect(cost('false ? false : true')).toBe(6);
  });

  test('a path literal costs 1 plus 1 per literal segment; an interpolated segment costs its expression', () => {
    // path(1) + databases, documents, t (3) + $(database)(1) + $(id)(1) = 6
    // ||(1) + exists(1) + path(6) + right operand(1) + true(1) = 10
    expect(cost('exists(/databases/$(database)/documents/t/$(id)) || true')).toBe(10);
  });

  test('a let costs 1 plus its value on every call, read or not', () => {
    const fn = 'function f() { let unused = 1 == 1; return true; }';
    // call(1) + let(1) + value(3) + body(1)
    expect(cost('f()', fn)).toBe(6);
    // Two calls pay twice: calls are not memoized.
    expect(cost('f() && f()', fn)).toBe(2 + 6 + 6);
  });

  test('a function call costs 1 plus its arguments and its body', () => {
    // call(1) + argument(1) + body: x(1) == (1) 1(1)
    expect(cost('g(1)', 'function g(x) { return x == 1; }')).toBe(5);
  });

  test('a builtin namespace identifier counts as an evaluated node', () => {
    // == (1) + math.abs(1) + math(1) + -1: unary(1) + 1(1) + 1(1)
    expect(cost('math.abs(-1) == 1')).toBe(6);
  });

  test('the count spans every allow rule the request evaluates, including rules that deny first', () => {
    const r = run(rules(`match /t/{id} {
      allow get: if false;
      allow get: if 1 == 2;
      allow get: if true;
    }`));
    expect(r.decision).toBe('ALLOW');
    expect(r.evaluatedExpressions).toBe(1 + 3 + 1);
  });

  test('the count spans every match block the request reaches', () => {
    const r = run(rules(`match /t/{id} { allow get: if false; }
    match /{document=**} { allow get: if true; }`));
    expect(r.decision).toBe('ALLOW');
    expect(r.evaluatedExpressions).toBe(2);
  });

  test('a request with no matching block evaluates nothing', () => {
    const r = run(rules('match /other/{id} { allow get: if true; }'));
    expect(r.evaluatedExpressions).toBe(0);
    expect(r.resourceLimit).toBeUndefined();
  });

  test('counting does not depend on the trace recorder', () => {
    const condition = `${trues(5)} && (false ? 1 == 1 : resource.data.s[0:1] == 'a')`;
    const ast = parseToAST(rules(`match /t/{id} { allow get: if ${condition}; }`))!;
    const expr = ast.service.match.children[0]!.allows[0]!.condition;
    const budget = new ExpressionBudget((message) => new ExpressionLimitError(message));
    const ctx = {
      request: { auth: null, resource: { data: {} }, method: 'get' },
      resource: { data: { s: 'abc' } },
      mockDocuments: new Map(),
      pathVariables: {},
      functions: new Map(),
      database: '(default)',
      expressionBudget: budget,
    } as unknown as SimulationContext;
    expect(evaluate(expr, ctx)).toBe(true);
    expect(budget.evaluated).toBe(cost(condition));
  });
});

describe('expression budget limit', () => {
  // f() is 90 trues: 90 + 2 * 89 = 268, and the call costs 1 more.
  const f = `function f() { return ${trues(90)}; }`;
  const F = 269;

  test(`a request may evaluate exactly ${EXPRESSION_LIMIT} expressions`, () => {
    // Three calls (807) and k trues are k + 3 operands joined by k + 2
    // operators of 2 each: 807 + k + 2(k + 2) = 811 + 3k, and k = 63 is 1000.
    const condition = `f() && f() && f() && ${trues(63)}`;
    const r = run(rules(`match /t/{id} { allow get: if ${condition}; }`, f));
    expect(r.evaluatedExpressions).toBe(EXPRESSION_LIMIT);
    expect(r.decision).toBe('ALLOW');
    expect(r.resourceLimit).toBeUndefined();
  });

  test(`the ${EXPRESSION_LIMIT + 1}st expression denies the request with production's message`, () => {
    // One more operator: the && node is the 1001st expression.
    const condition = `f() && f() && f() && ${trues(63)} && true`;
    const r = run(rules(`match /t/{id} { allow get: if ${condition}; }`, f));
    expect(r.decision).toBe('DENY');
    expect(r.evaluatedExpressions).toBe(EXPRESSION_LIMIT);
    expect(r.resourceLimit).toMatchObject({ kind: 'expressions', limit: EXPRESSION_LIMIT, message: EXPRESSION_LIMIT_MESSAGE });
    expect(EXPRESSION_LIMIT_MESSAGE).toBe(
      'Unable to evaluate the expression as the maximum of 1000 expressions to evaluate has been reached.',
    );
    expect(r.trace.at(-1)!.verdict).toBe('ERROR');
    expect(r.trace.at(-1)!.message).toBe(EXPRESSION_LIMIT_MESSAGE);
    expect(r.notes.some((n) => n.includes(EXPRESSION_LIMIT_MESSAGE))).toBe(true);
  });

  test('a determining || operand does not absorb the limit', () => {
    const r = run(rules(`match /t/{id} { allow get: if (f() && f() && f() && f()) || true; }`, f));
    expect(r.decision).toBe('DENY');
    expect(r.resourceLimit?.kind).toBe('expressions');
  });

  test('earlier denying rules spend the budget, and a later rule that would grant is not evaluated', () => {
    const r = run(rules(`match /t/{id} {
      allow get: if f() && f() && false;
      allow get: if f() && f() && false;
      allow get: if true;
    }`, f));
    expect(r.decision).toBe('DENY');
    expect(r.resourceLimit?.kind).toBe('expressions');
    expect(r.trace.map((t) => t.verdict)).toEqual(['DENY', 'ERROR']);
  });

  test('the limit ends the request before a later match block can grant', () => {
    const r = run(rules(`match /t/{id} { allow get: if f() && f() && f() && f(); }
    match /{document=**} { allow get: if true; }`, f));
    expect(r.decision).toBe('DENY');
    expect(r.resourceLimit?.kind).toBe('expressions');
  });

  test('each request gets its own budget', () => {
    const source = rules(`match /t/{id} { allow get: if f() && f(); }`, f);
    const result = handler.simulate(source, [GET, GET, GET, GET]);
    if (!result.success) throw new Error(result.error.message);
    for (const r of result.data.results) {
      expect(r.decision).toBe('ALLOW');
      expect(r.evaluatedExpressions).toBe(2 * F + 2);
    }
  });
});

describe('twelve functions of 90 comparisons in one rule', () => {
  // The ruleset of the arcade report: every comparison is true, each
  // function stays under the 98-operand chain compile limit, and together
  // they pass the limit.
  const terms = Array.from({ length: 90 }, () => 'request.resource.data.a == 1').join(' && ');
  const fns = Array.from({ length: 12 }, (_, i) => `function f${i}() { return ${terms}; }`).join('\n    ');
  const calls = Array.from({ length: 12 }, (_, i) => `f${i}()`).join(' && ');
  const source = rules(`match /docs/{id} { allow create: if ${calls}; }`, fns);
  const create = {
    description: 'over budget', expectation: 'DENY' as const, method: 'create' as const,
    path: 'docs/d1', auth: { uid: 'u' }, data: { a: 1 },
  };

  test('simulate denies at the limit and says so', () => {
    const summary = firestoreRules(source).simulate([create]);
    const [c] = summary.cases;
    expect(c!.decision).toBe('DENY');
    expect(c!.passed).toBe(true);
    expect(c!.evaluatedExpressions).toBe(EXPRESSION_LIMIT);
    expect(c!.resourceLimit).toMatchObject({ kind: 'expressions', limit: EXPRESSION_LIMIT, message: EXPRESSION_LIMIT_MESSAGE });
  });

  test('one of the functions stays under the limit', () => {
    const two = rules(`match /docs/{id} { allow create: if f0(); }`, fns);
    const [c] = firestoreRules(two).simulate([{ ...create, expectation: 'ALLOW' }]).cases;
    expect(c!.decision).toBe('ALLOW');
    // The call, 90 comparisons of 6 nodes (==, request, .resource, .data,
    // .a, 1), and 2 for each of the 89 && between them.
    expect(c!.evaluatedExpressions).toBe(1 + 90 * 6 + 89 * 2);
    expect(c!.resourceLimit).toBeUndefined();
  });

  test('explain reports the count and the limit', () => {
    const e = firestoreRules(source).explain(create);
    expect(e.evaluatedExpressions).toBe(EXPRESSION_LIMIT);
    expect(e.resourceLimit?.kind).toBe('expressions');
  });
});

describe('allow rules after an error', () => {
  // Production evaluates the method's later allow rules after one raises an
  // error: a later rule can grant, and what it evaluates counts toward the
  // limit. When the limit is reached after an earlier rule raised an error,
  // production reports that earlier error, not the limit. Captured in the
  // error-absorption-and-or scenario of the Firestore rules corpus.
  const f = `function f() { return ${trues(90)}; }`;
  const ERR = '[1] + [2] == [1, 2]';
  // == (1), + (1), [1] (2), [2] (2), and [1, 2] (3): production evaluates the
  // right operand of == after the left one errors.
  const ERR_COST = 9;

  test('a later rule in the same block grants, and both rules count', () => {
    const r = run(rules(`match /t/{id} {
      allow get: if ${ERR};
      allow get: if true;
    }`));
    expect(r.decision).toBe('ALLOW');
    expect(r.trace.map((t) => t.verdict)).toEqual(['ERROR', 'ALLOW']);
    expect(r.evaluatedExpressions).toBe(ERR_COST + 1);
  });

  test('a rule in a later match block grants after an error in an earlier one', () => {
    const r = run(rules(`match /t/{id} { allow get: if ${ERR}; }
    match /{document=**} { allow get: if true; }`));
    expect(r.decision).toBe('ALLOW');
    expect(r.evaluatedExpressions).toBe(ERR_COST + 1);
  });

  test('each rule records the count at which its evaluation ended', () => {
    const r = run(rules(`match /t/{id} {
      allow get: if false;
      allow get: if ${ERR};
      allow get: if 1 == 2;
      allow get: if true;
    }`));
    expect(r.trace.map((t) => t.evaluatedExpressions)).toEqual([1, 1 + ERR_COST, 1 + ERR_COST + 3, 1 + ERR_COST + 4]);
  });

  test('the limit reached after an earlier rule raised an error is reported as that error', () => {
    const r = run(rules(`match /t/{id} {
      allow get: if ${ERR};
      allow get: if f() && f() && f() && f();
    }`, f));
    expect(r.decision).toBe('DENY');
    expect(r.evaluatedExpressions).toBe(EXPRESSION_LIMIT);
    expect(r.resourceLimit).toBeUndefined();
    expect(r.trace.map((t) => t.verdict)).toEqual(['ERROR', 'ERROR']);
    expect(r.trace[0]!.message).toContain('+');
    expect(r.trace[1]!.message).toBe(EXPRESSION_LIMIT_MESSAGE);
    expect(r.notes.some((n) => n.includes(EXPRESSION_LIMIT_MESSAGE) && n.includes('earlier'))).toBe(true);
  });

  test('the same holds across match blocks', () => {
    const r = run(rules(`match /t/{id} { allow get: if ${ERR}; }
    match /{document=**} { allow get: if f() && f() && f() && f(); }`, f));
    expect(r.decision).toBe('DENY');
    expect(r.resourceLimit).toBeUndefined();
  });

  test('the limit is reported when every earlier rule evaluated without an error', () => {
    const r = run(rules(`match /t/{id} {
      allow get: if false;
      allow get: if f() && f() && f() && f();
    }`, f));
    expect(r.resourceLimit?.kind).toBe('expressions');
  });
});
