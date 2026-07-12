/**
 * ─── r9-quota-math ────────────────────────────────────────────────────────
 * A per-user usage quota, whose fields are pinned to each other by ARITHMETIC:
 *   - `limit` must equal the plan's allowance (`100 * (plan + 1)`) and be a
 *     whole multiple of ten;
 *   - `used` must be a whole number (`% 1 === 0`) from zero up to `limit + grace`
 *     (the overage allowance);
 *   - `remaining` must equal `limit - used`;
 *   - `pctUsed` must equal `used * 100 / limit`, guarded by a ternary against a
 *     zero limit.
 * The `.write` rule is a ratchet: a quota that already exists may only have its
 * limit raised, never lowered.
 *
 * This is the operator scenario — one coherent ruleset that exercises
 * `+ - * / %`, `< <= > >=`, `||`, the ternary and unary minus, plus
 * `newData.parent()` navigation between sibling fields.
 *
 * PRODUCTION REJECTS ARRAY LITERALS IN EXPRESSIONS. The plan allowance was
 * first authored as a table lookup, `[10, 100, 1000][plan]`. Production's rules
 * parser refuses the ruleset outright — `Unexpected array literal.` — so an
 * array literal is legal ONLY as a `hasChildren([...])` argument, never as an
 * operand. Production won: the allowance is arithmetic. The index operator has
 * its own production-accepted form (`auth.token['admin']`), exercised in
 * r12-claims-and-server-time.
 *
 * Expectations are the PRODUCTION verdicts recorded by the deploy-observe-
 * restore capture (observations/rtdb-rules/rules-rtdb-r9-quota-math.json).
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'arithmetic and comparison operators decide a real quota: the limit is pinned to the plan by multiplication and addition, remaining by subtraction, pctUsed by multiplication and division under a ternary zero-guard, and the write ratchet uses || plus >= — production must agree with the simulator on every field.',
  provenance:
    'Authored to exercise the rtdb operator constructs (add/sub/mul/div/mod, lt/lte/gt/gte, or, ternary, unary minus) and captured against the live oracle database; expectations are the captured production verdicts. The first draft looked the limit up in an array-literal plan table; production rejected the ruleset ("Unexpected array literal"), so the rule became arithmetic.',
  rules: JSON.stringify({
    $uid: {
      '.read': '$uid === auth.uid',
      '.write': "$uid === auth.uid && (!data.exists() || newData.child('limit').val() >= data.child('limit').val())",
      '.validate': "newData.hasChildren(['plan', 'limit', 'grace', 'used', 'remaining', 'pctUsed'])",
      plan: {
        '.validate': 'newData.isNumber() && newData.val() >= 0 && newData.val() < 3',
      },
      limit: {
        '.validate':
          "newData.isNumber() && newData.val() === 100 * (newData.parent().child('plan').val() + 1) && newData.val() % 10 === 0",
      },
      grace: {
        '.validate': 'newData.isNumber() && newData.val() >= 0 && newData.val() < 10',
      },
      used: {
        '.validate':
          "newData.isNumber() && newData.val() % 1 === 0 && newData.val() > -1 && newData.val() <= newData.parent().child('limit').val() + newData.parent().child('grace').val()",
      },
      remaining: {
        '.validate': "newData.val() === newData.parent().child('limit').val() - newData.parent().child('used').val()",
      },
      pctUsed: {
        '.validate':
          "newData.val() === (newData.parent().child('limit').val() > 0 ? newData.parent().child('used').val() * 100 / newData.parent().child('limit').val() : 0)",
      },
    },
  }),
  cases: [
    {
      description: 'consistent quota allowed',
      expectation: 'ALLOW',
      operation: 'write',
      opPath: '/<UID>',
      authPresent: true,
      newData: { plan: 1, limit: 200, grace: 5, used: 30, remaining: 170, pctUsed: 15 },
    },
    {
      description: 'used beyond limit plus grace denied (add)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/<UID>',
      authPresent: true,
      newData: { plan: 1, limit: 200, grace: 5, used: 206, remaining: -6, pctUsed: 103 },
    },
    {
      description: 'limit not the plan allowance denied (mul)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/<UID>',
      authPresent: true,
      newData: { plan: 0, limit: 200, grace: 5, used: 30, remaining: 170, pctUsed: 15 },
    },
    {
      description: 'fractional used denied (mod)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/<UID>',
      authPresent: true,
      newData: { plan: 1, limit: 200, grace: 5, used: 30.5, remaining: 169.5, pctUsed: 15.25 },
    },
    {
      description: 'remaining not limit minus used denied (sub)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/<UID>',
      authPresent: true,
      newData: { plan: 1, limit: 200, grace: 5, used: 30, remaining: 171, pctUsed: 15 },
    },
    {
      description: 'pctUsed not used times 100 over limit denied (div)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/<UID>',
      authPresent: true,
      newData: { plan: 1, limit: 200, grace: 5, used: 30, remaining: 170, pctUsed: 16 },
    },
    {
      description: 'negative used denied (unary minus bound)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/<UID>',
      authPresent: true,
      newData: { plan: 1, limit: 200, grace: 5, used: -1, remaining: 201, pctUsed: -0.5 },
    },
    {
      description: 'grace at or above ten denied (lt)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/<UID>',
      authPresent: true,
      newData: { plan: 1, limit: 200, grace: 10, used: 30, remaining: 170, pctUsed: 15 },
    },
    { description: 'owner reads own quota', expectation: 'ALLOW', operation: 'read', opPath: '/<UID>', authPresent: true },
    { description: 'foreign quota read denied', expectation: 'DENY', operation: 'read', opPath: '/some-other-uid', authPresent: true },
    {
      description: 'lowering an existing limit denied (write ratchet)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/<UID>',
      authPresent: true,
      mockData: { plan: 1, limit: 200, grace: 5, used: 30, remaining: 170, pctUsed: 15 },
      newData: { plan: 0, limit: 100, grace: 5, used: 5, remaining: 95, pctUsed: 5 },
    },
    {
      description: 'raising an existing limit allowed (write ratchet)',
      expectation: 'ALLOW',
      operation: 'write',
      opPath: '/<UID>',
      authPresent: true,
      mockData: { plan: 1, limit: 200, grace: 5, used: 30, remaining: 170, pctUsed: 15 },
      newData: { plan: 2, limit: 300, grace: 5, used: 30, remaining: 270, pctUsed: 10 },
    },
  ],
};
