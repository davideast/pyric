/**
 * ─── r48-object-equality ─────────────────────────────────────────
 * How production evaluates ==, != and === when an operand is an object value
 * from val(). pyric compares JavaScript references: val() builds a fresh object
 * per call, so data.val() == data.val() is false and identical objects are
 * always !=. No observation covers an object under an equality operator (r22 and
 * r25 are primitives; r37 shows an object fails + and <).
 *
 * Captured 2026-10-26: production agrees with pyric on every case. An object
 * operand does not fail the rule: == with an object is false and != is true,
 * even for two identical objects, so the hunt's belief (SP-3) was refuted.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'pyric compares object values from val() by JavaScript reference, so equal objects are never == and always !=; production either fails the rule or compares by content.',
  provenance:
    'Drafted from the 2026-10-26 RTDB simulator-vs-production hunt (SP-3). Captured by deploy-observe-restore against pyric-oracle-rtdb on 2026-10-26 in observations/rtdb-rules/rules-rtdb-r48-object-equality.json.',
  rules: JSON.stringify({
    reflexive: { '.read': 'data.val() == data.val()' },
    same: { '.write': 'auth != null', '.validate': 'data.val() == newData.val()' },
    changed: { '.write': 'auth != null', '.validate': 'data.val() != newData.val()' },
    strictsame: { '.write': 'auth != null', '.validate': 'data.val() === newData.val()' },
    notx: { '.write': 'auth != null', '.validate': "!(newData.val() == 'x')" },
    neqxortrue: { '.write': 'auth != null', '.validate': "newData.val() != 'x' || true" },
    isnull: { '.write': 'auth != null', '.validate': '!(newData.val() == null)' },
  }),
  cases: [
    { description: 'SP-3: an object read compared with itself (data.val() == data.val())', expectation: 'DENY', operation: 'read', opPath: '/reflexive', authPresent: true, seed: { '/reflexive': { a: 1 } } },
    { description: 'SP-3: identical objects under ==', expectation: 'DENY', operation: 'write', opPath: '/same', authPresent: true, newData: { a: 1 }, seed: { '/same': { a: 1 } } },
    { description: 'SP-3: identical objects under !=', expectation: 'ALLOW', operation: 'write', opPath: '/changed', authPresent: true, newData: { a: 1 }, seed: { '/changed': { a: 1 } } },
    { description: 'SP-3: different objects under !=', expectation: 'ALLOW', operation: 'write', opPath: '/changed', authPresent: true, newData: { a: 2 }, seed: { '/changed': { a: 1 } } },
    { description: 'SP-3: identical objects under ===', expectation: 'DENY', operation: 'write', opPath: '/strictsame', authPresent: true, newData: { a: 1 }, seed: { '/strictsame': { a: 1 } } },
    { description: "SP-3: an object under !(X == 'x')", expectation: 'ALLOW', operation: 'write', opPath: '/notx', authPresent: true, newData: { a: 1 } },
    { description: "SP-3: an object under X != 'x' || true", expectation: 'ALLOW', operation: 'write', opPath: '/neqxortrue', authPresent: true, newData: { a: 1 } },
    { description: 'SP-3: an object under !(X == null)', expectation: 'ALLOW', operation: 'write', opPath: '/isnull', authPresent: true, newData: { a: 1 } },
    { description: 'SP-3 control: identical numbers under ==', expectation: 'ALLOW', operation: 'write', opPath: '/same', authPresent: true, newData: 5, seed: { '/same': 5 } },
    { description: 'SP-3 control: different numbers under !=', expectation: 'ALLOW', operation: 'write', opPath: '/changed', authPresent: true, newData: 6, seed: { '/changed': 5 } },
  ],
};
