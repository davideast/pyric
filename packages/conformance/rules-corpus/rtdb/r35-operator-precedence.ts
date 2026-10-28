/**
 * ─── r35-operator-precedence ──────────────────────────────────────────────
 * Operator precedence and associativity in rule expressions without
 * parentheses. Each node carries one `.read` built from literals only, so the
 * way the expression groups decides the verdict and no stored data is read.
 *
 * Every case separates two groupings: `&&` over `||`, relational over
 * equality, `*` over `+`, `!` and unary minus over binary operators, a
 * ternary condition taking the whole `||`, a right-associative ternary,
 * left-associative `-` and `/`, and `%` and `*` at one level.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'a rule that mixes operators without parentheses must group them as production does, or the simulator grants or denies a request production decides the other way.',
  provenance:
    'Authored to pin operator precedence against production directly. Expectations are the production allow/deny verdicts recorded by the deploy-observe-restore capture in observations/rtdb-rules/rules-rtdb-r35-operator-precedence.json.',
  rules: JSON.stringify({
    notorand: { '.read': '!(true || false && false)' },
    andor: { '.read': 'false && false || true' },
    orand: { '.read': 'true || false && false' },
    eqlt: { '.read': 'false == 1 < 2' },
    eqltleft: { '.read': 'true == 1 < 2' },
    ltchain: { '.read': '1 < 2 == 2 < 3' },
    mulover: { '.read': '1 + 2 * 3 == 7' },
    ternaryor: { '.read': 'true || false ? false : true' },
    ternaryorand: { '.read': 'true || false && false ? true : false' },
    ternaryright: { '.read': 'true ? false : true ? true : true' },
    ternaryelse: { '.read': 'true ? false : true || true' },
    notand: { '.read': '!false && false' },
    negadd: { '.read': '-1 + 2 == 1' },
    subleft: { '.read': '10 - 4 - 3 == 3' },
    divleft: { '.read': '8 / 4 / 2 == 1' },
    modmul: { '.read': '7 % 4 * 2 == 6' },
  }),
  cases: [
    { description: '!(true || false && false) groups && first', expectation: 'DENY', operation: 'read', opPath: '/notorand', authPresent: false },
    { description: 'false && false || true groups && first', expectation: 'ALLOW', operation: 'read', opPath: '/andor', authPresent: false },
    { description: 'true || false && false groups && first', expectation: 'ALLOW', operation: 'read', opPath: '/orand', authPresent: false },
    { description: 'false == 1 < 2 groups < before ==', expectation: 'DENY', operation: 'read', opPath: '/eqlt', authPresent: false },
    { description: 'true == 1 < 2 groups < before ==', expectation: 'ALLOW', operation: 'read', opPath: '/eqltleft', authPresent: false },
    { description: '1 < 2 == 2 < 3 compares two comparisons', expectation: 'ALLOW', operation: 'read', opPath: '/ltchain', authPresent: false },
    { description: '1 + 2 * 3 == 7 groups * before +', expectation: 'ALLOW', operation: 'read', opPath: '/mulover', authPresent: false },
    { description: 'true || false ? false : true takes the whole || as the condition', expectation: 'DENY', operation: 'read', opPath: '/ternaryor', authPresent: false },
    { description: 'true || false && false ? true : false takes the whole || as the condition', expectation: 'ALLOW', operation: 'read', opPath: '/ternaryorand', authPresent: false },
    { description: 'true ? false : true ? true : true groups the ternary to the right', expectation: 'DENY', operation: 'read', opPath: '/ternaryright', authPresent: false },
    { description: 'true ? false : true || true keeps || inside the else branch', expectation: 'DENY', operation: 'read', opPath: '/ternaryelse', authPresent: false },
    { description: '!false && false applies ! before &&', expectation: 'DENY', operation: 'read', opPath: '/notand', authPresent: false },
    { description: '-1 + 2 == 1 applies unary minus before +', expectation: 'ALLOW', operation: 'read', opPath: '/negadd', authPresent: false },
    { description: '10 - 4 - 3 == 3 groups - to the left', expectation: 'ALLOW', operation: 'read', opPath: '/subleft', authPresent: false },
    { description: '8 / 4 / 2 == 1 groups / to the left', expectation: 'ALLOW', operation: 'read', opPath: '/divleft', authPresent: false },
    { description: '7 % 4 * 2 == 6 groups % and * to the left', expectation: 'ALLOW', operation: 'read', opPath: '/modmul', authPresent: false },
  ],
};
