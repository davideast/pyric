/**
 * ─── r10-snapshot-type-guards ─────────────────────────────────────────────
 * The snapshot structure and type predicates: `hasChild` at the record node,
 * `isString`/`isNumber`/`isBoolean` on each field, and `parent()` climbing from a
 * field back to the record it belongs to.
 *
 * Every op writes the WHOLE `/profile` object rather than a single field. That is
 * deliberate: a `set` REPLACES the node, so `newData` at `/profile` is exactly the
 * written object and `newData.parent()` from `/profile/name` sees only the fields
 * this write supplies. A per-field write would instead let `parent()` observe
 * siblings left behind by an earlier case, making the verdict depend on run order.
 *
 * Note that RTDB runs a child `.validate` only for children PRESENT in `newData`:
 * the "name without age" case is denied by `/profile/name`'s own `parent()` guard,
 * not by `/profile/age`'s type rule, which never runs.
 *
 * Covers: hasChild, parent, isString, isNumber, isBoolean.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'structure and type guards are the backbone of RTDB validation rules, and `parent()` re-projects a field snapshot at its record node — the simulator must resolve both the type predicates and the upward path climb exactly as production does.',
  provenance:
    'Authored to close the rules-language construct gaps left by r1-r8, which exercised no type predicate and no upward path climb. Expectations are the production allow/deny verdicts recorded by the deploy-observe-restore capture in observations/rtdb-rules/rules-rtdb-r10-snapshot-type-guards.json.',
  rules: JSON.stringify({
    '.read': 'auth != null',
    profile: {
      '.write': 'auth != null',
      '.validate': "newData.hasChild('name')",
      name: { '.validate': "newData.isString() && newData.parent().hasChild('age')" },
      age: { '.validate': 'newData.isNumber()' },
      active: { '.validate': 'newData.isBoolean()' },
    },
  }),
  cases: [
    { description: 'well-typed profile allowed', expectation: 'ALLOW', operation: 'write', opPath: '/profile', authPresent: true, newData: { name: 'ada', age: 36, active: true } },
    { description: 'missing required name child denied', expectation: 'DENY', operation: 'write', opPath: '/profile', authPresent: true, newData: { age: 36, active: true } },
    { description: 'numeric name fails isString', expectation: 'DENY', operation: 'write', opPath: '/profile', authPresent: true, newData: { name: 42, age: 36, active: true } },
    { description: 'string age fails isNumber', expectation: 'DENY', operation: 'write', opPath: '/profile', authPresent: true, newData: { name: 'ada', age: '36', active: true } },
    { description: 'string active fails isBoolean', expectation: 'DENY', operation: 'write', opPath: '/profile', authPresent: true, newData: { name: 'ada', age: 36, active: 'yes' } },
    { description: 'name without sibling age fails the parent climb', expectation: 'DENY', operation: 'write', opPath: '/profile', authPresent: true, newData: { name: 'ada', active: true } },
    { description: 'auth-gated read allowed', expectation: 'ALLOW', operation: 'read', opPath: '/profile', authPresent: true },
  ],
};
