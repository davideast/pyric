/**
 * ─── r9-quota-arithmetic ──────────────────────────────────────────────────
 * The arithmetic and comparison operators, in the shape they actually appear in:
 * counters, size caps and range checks. Each child node carries ONE predicate and
 * the ops write directly AT that node, so `newData` is projected at the rule node
 * and the operator under test — not rule placement — decides the verdict.
 *
 * `data` is controlled per case via `mockData`, which the capture runner seeds at
 * the op path with the admin SDK before the write (bypassing the rule) and the
 * replay suite nests at the same path. Every delta rule (`increment`, `decrement`,
 * `scaled`, `halved`, `tiered`) therefore reads a known pre-existing value rather
 * than a residue of an earlier case.
 *
 * Covers: + - * / % > >= < <= !== ==(loose) || ?: and unary minus.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'the arithmetic and comparison operators carry real quota rules (increment-only counters, range caps, parity and tier bounds), so the simulator must reproduce production\'s evaluation of each operator, including loose equality and the ternary.',
  provenance:
    'Authored to close the rules-language construct gaps left by r1-r8, which exercised no arithmetic or ordering operator. Expectations are the production allow/deny verdicts recorded by the deploy-observe-restore capture in observations/rtdb-rules/rules-rtdb-r9-quota-arithmetic.json.',
  rules: JSON.stringify({
    '.read': 'auth != null',
    increment: {
      '.write': 'auth != null',
      '.validate': 'newData.isNumber() && newData.val() === data.val() + 1',
    },
    decrement: {
      '.write': 'auth != null',
      '.validate': 'newData.val() === data.val() - 1',
    },
    scaled: {
      '.write': 'auth != null',
      '.validate': 'newData.val() === data.val() * 2',
    },
    halved: {
      '.write': 'auth != null',
      '.validate': 'newData.val() === data.val() / 2',
    },
    evenonly: {
      '.write': 'auth != null',
      '.validate': 'newData.val() % 2 === 0',
    },
    range: {
      '.write': 'auth != null',
      '.validate': 'newData.val() >= 1 && newData.val() <= 100',
    },
    strictbound: {
      '.write': 'auth != null',
      '.validate': 'newData.val() > 0 && newData.val() < 10',
    },
    notsentinel: {
      '.write': 'auth != null',
      '.validate': 'newData.val() !== -1',
    },
    loosezero: {
      '.write': 'auth != null',
      '.validate': 'newData.val() == 0',
    },
    eitherflag: {
      '.write': 'auth != null',
      '.validate': "newData.val() === 'on' || newData.val() === 'off'",
    },
    tiered: {
      '.write': 'auth != null',
      '.validate': 'newData.val() <= (data.val() > 50 ? 200 : 100)',
    },
  }),
  cases: [
    { description: 'increment by one allowed', expectation: 'ALLOW', operation: 'write', opPath: '/increment', authPresent: true, mockData: 4, newData: 5 },
    { description: 'increment by three denied', expectation: 'DENY', operation: 'write', opPath: '/increment', authPresent: true, mockData: 4, newData: 7 },
    { description: 'decrement by one allowed', expectation: 'ALLOW', operation: 'write', opPath: '/decrement', authPresent: true, mockData: 4, newData: 3 },
    { description: 'decrement by two denied', expectation: 'DENY', operation: 'write', opPath: '/decrement', authPresent: true, mockData: 4, newData: 2 },
    { description: 'doubled value allowed', expectation: 'ALLOW', operation: 'write', opPath: '/scaled', authPresent: true, mockData: 4, newData: 8 },
    { description: 'non-doubled value denied', expectation: 'DENY', operation: 'write', opPath: '/scaled', authPresent: true, mockData: 4, newData: 9 },
    { description: 'halved value allowed', expectation: 'ALLOW', operation: 'write', opPath: '/halved', authPresent: true, mockData: 4, newData: 2 },
    { description: 'non-halved value denied', expectation: 'DENY', operation: 'write', opPath: '/halved', authPresent: true, mockData: 4, newData: 3 },
    { description: 'even value passes modulo check', expectation: 'ALLOW', operation: 'write', opPath: '/evenonly', authPresent: true, newData: 4 },
    { description: 'odd value fails modulo check', expectation: 'DENY', operation: 'write', opPath: '/evenonly', authPresent: true, newData: 5 },
    { description: 'value inside inclusive range allowed', expectation: 'ALLOW', operation: 'write', opPath: '/range', authPresent: true, newData: 50 },
    { description: 'value above inclusive range denied', expectation: 'DENY', operation: 'write', opPath: '/range', authPresent: true, newData: 101 },
    { description: 'value inside exclusive bound allowed', expectation: 'ALLOW', operation: 'write', opPath: '/strictbound', authPresent: true, newData: 5 },
    { description: 'value at exclusive upper bound denied', expectation: 'DENY', operation: 'write', opPath: '/strictbound', authPresent: true, newData: 10 },
    { description: 'negative sentinel denied by strict inequality', expectation: 'DENY', operation: 'write', opPath: '/notsentinel', authPresent: true, newData: -1 },
    { description: 'non-sentinel value allowed by strict inequality', expectation: 'ALLOW', operation: 'write', opPath: '/notsentinel', authPresent: true, newData: 7 },
    { description: 'zero passes loose equality', expectation: 'ALLOW', operation: 'write', opPath: '/loosezero', authPresent: true, newData: 0 },
    { description: 'nonzero fails loose equality', expectation: 'DENY', operation: 'write', opPath: '/loosezero', authPresent: true, newData: 3 },
    { description: 'first disjunct satisfies or', expectation: 'ALLOW', operation: 'write', opPath: '/eitherflag', authPresent: true, newData: 'on' },
    { description: 'neither disjunct satisfies or', expectation: 'DENY', operation: 'write', opPath: '/eitherflag', authPresent: true, newData: 'maybe' },
    { description: 'ternary high tier raises the cap', expectation: 'ALLOW', operation: 'write', opPath: '/tiered', authPresent: true, mockData: 60, newData: 200 },
    { description: 'ternary low tier keeps the cap', expectation: 'DENY', operation: 'write', opPath: '/tiered', authPresent: true, mockData: 10, newData: 200 },
    { description: 'auth-gated read allowed', expectation: 'ALLOW', operation: 'read', opPath: '/increment', authPresent: true },
  ],
};
