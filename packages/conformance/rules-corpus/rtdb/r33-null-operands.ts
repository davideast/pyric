/**
 * ─── r33-null-operands ────────────────────────────────────────────────────
 * Arithmetic and ordering operators with a null operand, where nothing is
 * stored, under `|| true`. r27-stdlib-core-patterns records `+`, `-`, `*`,
 * unary `-` and `<` failing the whole rule this way; this scenario records
 * the remaining operators: `/`, `%`, `<=`, `>` and `>=`, with a control for
 * each in which a value is stored.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'an operator with a null operand must fail the rule as production does, never compute null as 0, so a rule with `|| true` cannot grant through it.',
  provenance:
    'Authored to pin the operators r27-stdlib-core-patterns does not cover. Expectations are the production allow/deny verdicts recorded by the deploy-observe-restore capture in observations/rtdb-rules/rules-rtdb-r33-null-operands.json.',
  rules: JSON.stringify({
    div: { '.write': 'auth != null', '.validate': 'data.val() / 2 == 0 || true' },
    mod: { '.write': 'auth != null', '.validate': 'data.val() % 2 == 0 || true' },
    lte: { '.write': 'auth != null', '.validate': 'data.val() <= 1 || true' },
    gt: { '.write': 'auth != null', '.validate': 'data.val() > 1 || true' },
    gte: { '.write': 'auth != null', '.validate': 'data.val() >= 1 || true' },
    gtright: { '.write': 'auth != null', '.validate': '1 > data.val() || true' },
  }),
  cases: [
    { description: 'dividing nothing stored by 2, then or true', expectation: 'DENY', operation: 'write', opPath: '/div', authPresent: true, newData: 1 },
    { description: 'dividing a stored number by 2, then or true', expectation: 'ALLOW', operation: 'write', opPath: '/div', authPresent: true, newData: 1, mockData: 4 },
    { description: 'nothing stored modulo 2, then or true', expectation: 'DENY', operation: 'write', opPath: '/mod', authPresent: true, newData: 1 },
    { description: 'a stored number modulo 2, then or true', expectation: 'ALLOW', operation: 'write', opPath: '/mod', authPresent: true, newData: 1, mockData: 4 },
    { description: 'nothing stored at most 1, then or true', expectation: 'DENY', operation: 'write', opPath: '/lte', authPresent: true, newData: 1 },
    { description: 'a stored number at most 1, then or true', expectation: 'ALLOW', operation: 'write', opPath: '/lte', authPresent: true, newData: 1, mockData: 4 },
    { description: 'nothing stored greater than 1, then or true', expectation: 'DENY', operation: 'write', opPath: '/gt', authPresent: true, newData: 1 },
    { description: 'a stored number greater than 1, then or true', expectation: 'ALLOW', operation: 'write', opPath: '/gt', authPresent: true, newData: 1, mockData: 4 },
    { description: 'nothing stored at least 1, then or true', expectation: 'DENY', operation: 'write', opPath: '/gte', authPresent: true, newData: 1 },
    { description: 'a stored number at least 1, then or true', expectation: 'ALLOW', operation: 'write', opPath: '/gte', authPresent: true, newData: 1, mockData: 4 },
    { description: '1 greater than nothing stored, then or true', expectation: 'DENY', operation: 'write', opPath: '/gtright', authPresent: true, newData: 1 },
  ],
};
