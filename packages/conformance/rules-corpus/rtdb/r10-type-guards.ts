/**
 * ─── r10-type-guards ──────────────────────────────────────────────────────
 * A user-profile ruleset that leans entirely on the snapshot TYPE GUARDS:
 * `name` must be a non-empty string, `age` a number, `active` a boolean; the
 * profile must carry a `name` child and must NOT carry an `internal` child
 * (`hasChild` positive and negated). The `.write` rule is the lock idiom: a
 * profile may be rewritten only while it carries no truthy `locked` flag,
 * expressed with loose equality against null (`data.child('locked').val() ==
 * null`) so an ABSENT flag and an explicit null read the same.
 *
 * This is the type-guard scenario: `isString` / `isNumber` / `isBoolean` /
 * `hasChild`, plus strict inequality (`!==`) and loose equality (`==`).
 *
 * Expectations are the PRODUCTION verdicts recorded by the deploy-observe-
 * restore capture (observations/rtdb-rules/rules-rtdb-r10-type-guards.json).
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'the snapshot type guards decide a real profile write: a stringly-typed age, a stringly-typed active flag, an empty name and a reserved internal child must each deny, and the locked-profile lock must hold — production and the simulator must agree guard for guard.',
  provenance:
    'Authored to exercise the rtdb snapshot type-guard methods (isString/isNumber/isBoolean/hasChild) and the strict-inequality / loose-equality operators, then captured against the live oracle database; expectations are the captured production verdicts.',
  rules: JSON.stringify({
    $uid: {
      '.read': 'auth != null',
      '.write':
        "$uid === auth.uid && (data.child('locked').val() == null || data.child('locked').val() === false)",
      '.validate': "newData.hasChild('name') && !newData.hasChild('internal')",
      name: { '.validate': "newData.isString() && newData.val() !== ''" },
      age: { '.validate': 'newData.isNumber()' },
      active: { '.validate': 'newData.isBoolean()' },
    },
  }),
  cases: [
    {
      description: 'well-typed profile allowed',
      expectation: 'ALLOW',
      operation: 'write',
      opPath: '/<UID>',
      authPresent: true,
      newData: { name: 'ada', age: 36, active: true },
    },
    {
      description: 'empty name denied (strict inequality)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/<UID>',
      authPresent: true,
      newData: { name: '', age: 36, active: true },
    },
    {
      description: 'numeric age as string denied (isNumber)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/<UID>',
      authPresent: true,
      newData: { name: 'ada', age: '36', active: true },
    },
    {
      description: 'boolean active as string denied (isBoolean)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/<UID>',
      authPresent: true,
      newData: { name: 'ada', age: 36, active: 'yes' },
    },
    {
      description: 'name as number denied (isString)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/<UID>',
      authPresent: true,
      newData: { name: 7, age: 36, active: true },
    },
    {
      description: 'missing name denied (hasChild)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/<UID>',
      authPresent: true,
      newData: { age: 36, active: true },
    },
    {
      description: 'reserved internal child denied (negated hasChild)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/<UID>',
      authPresent: true,
      newData: { name: 'ada', age: 36, active: true, internal: 1 },
    },
    { description: 'any signed-in user reads a profile', expectation: 'ALLOW', operation: 'read', opPath: '/<UID>', authPresent: true },
    {
      description: 'foreign profile write denied',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/some-other-uid',
      authPresent: true,
      newData: { name: 'mallory', age: 1, active: true },
    },
    {
      description: 'unlocked profile rewritten (loose equality against null)',
      expectation: 'ALLOW',
      operation: 'write',
      opPath: '/<UID>',
      authPresent: true,
      mockData: { name: 'ada', age: 36, active: true, locked: false },
      newData: { name: 'ada lovelace', age: 36, active: true },
    },
    {
      description: 'locked profile rewrite denied',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/<UID>',
      authPresent: true,
      mockData: { name: 'ada', age: 36, active: true, locked: true },
      newData: { name: 'mallory', age: 1, active: true },
    },
  ],
};
