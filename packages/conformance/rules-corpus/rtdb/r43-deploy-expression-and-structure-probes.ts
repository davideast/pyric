/**
 * ─── r43-deploy-expression-and-structure-probes ───────────────────────────
 * Dry-run deploy validation probes (`PUT /.settings/rules.json?dryRun=true`)
 * for expression and structural edge cases surfaced during the 2026-10-15 bug
 * hunt:
 *
 *   - `COV-2`: overflowing numeric exponent literal `1e309` in a rule string.
 *   - `COV-1`: `root.parent()` in mixed-branch ternaries and equality checks.
 *   - `FUZ-4`: `auth[...]` and `auth.token[...]` indexed by snapshot, boolean,
 *     `null`, or dynamic child value.
 *   - `CON-6`: unknown `.`-prefixed key with a boolean value (`".valdiate": false`),
 *     and non-object child values (`true`, `null`, `42`, `[{".read": true}]`,
 *     and `.read: [true]`).
 *
 * Expectations record the production dry-run deploy verdicts and error texts
 * captured on 2026-10-15 in
 * `observations/rtdb-rules/rules-rtdb-r43-deploy-expression-and-structure-probes.json`.
 */
import type { RtdbDeployScenarioRecord } from './types.ts';

const subtree = (rules: Record<string, unknown>): string => JSON.stringify(rules);

export const scenario: RtdbDeployScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'every expression or tree shape production refuses on dry-run deploy must be rejected by rtdbRulesSourceRejection, and every form production accepts must compile without false rejection.',
  provenance:
    'Authored from 2026-10-15 bug hunt (COV-1, COV-2, FUZ-4, CON-6) to pin dry-run deploy verdicts and error messages for expression and structural edge cases against production. Captured by deploy-observe-restore (dry-run deploy) on 2026-10-15 in observations/rtdb-rules/rules-rtdb-r43-deploy-expression-and-structure-probes.json.',
  deployCases: [
    {
      description: 'COV-2: overflowing exponent literal 1e309 in a rule expression',
      construct: 'rtdb.operator.gt',
      rules: subtree({ a: { '.read': '1e309 > 100' } }),
      expectation: { verdict: 'ACCEPTED' },
    },
    {
      description: 'COV-1: root.parent() in mixed-branch ternary compared with null',
      construct: 'rtdb.method.snapshot.parent',
      rules: subtree({ a: { '.read': '(true ? root.parent() : null) == null' } }),
      expectation: { verdict: 'ACCEPTED' },
    },
    {
      description: 'COV-1: root.parent() != null || true',
      construct: 'rtdb.method.snapshot.parent',
      rules: subtree({ a: { '.read': 'root.parent() != null || true' } }),
      expectation: {
        verdict: 'REJECTED',
        error: 'Invalid != expression: left operand is not a number, boolean, string, or null.',
      },
    },
    {
      description: 'COV-1: ((true ? root.parent() : 1) == 1) || true',
      construct: 'rtdb.method.snapshot.parent',
      rules: subtree({ a: { '.read': '((true ? root.parent() : 1) == 1) || true' } }),
      expectation: { verdict: 'ACCEPTED' },
    },
    {
      description: 'FUZ-4: auth indexed by snapshot (auth[data])',
      construct: 'rtdb.operator.index',
      rules: subtree({ a: { '.read': 'auth[data] == true' } }),
      expectation: {
        verdict: 'REJECTED',
        error: "Invalid property access on 'auth' object.",
      },
    },
    {
      description: 'FUZ-4: auth indexed by boolean literal (auth[true])',
      construct: 'rtdb.operator.index',
      rules: subtree({ a: { '.read': 'auth[true] == true' } }),
      expectation: {
        verdict: 'REJECTED',
        error: "Invalid property access on 'auth' object.",
      },
    },
    {
      description: 'FUZ-4: auth indexed by null literal (auth[null])',
      construct: 'rtdb.operator.index',
      rules: subtree({ a: { '.read': 'auth[null] == true' } }),
      expectation: {
        verdict: 'REJECTED',
        error: "Invalid property access on 'auth' object.",
      },
    },
    {
      description: "FUZ-4: auth.token indexed by dynamic child value (auth.token[data.child('k').val()])",
      construct: 'rtdb.operator.index',
      rules: subtree({ a: { '.read': "auth.token[data.child('k').val()] == true" } }),
      expectation: { verdict: 'ACCEPTED' },
    },
    {
      description: 'CON-6: unknown dotted rule key with boolean value (".valdiate": false)',
      construct: 'rtdb.rule-kind.unknown-key',
      rules: subtree({ a: { '.valdiate': false } }),
      expectation: { verdict: 'REJECTED', error: "Expected '{'." },
    },
    {
      description: 'CON-6: child node whose value is boolean true',
      construct: 'rtdb.rule-kind.non-object-child',
      rules: subtree({ a: { b: true } }),
      expectation: { verdict: 'REJECTED', error: "Expected '{'." },
    },
    {
      description: 'CON-6: child node whose value is null',
      construct: 'rtdb.rule-kind.non-object-child',
      rules: subtree({ a: { b: null } }),
      expectation: { verdict: 'REJECTED', error: "Expected '{'." },
    },
    {
      description: 'CON-6: child node whose value is number 42',
      construct: 'rtdb.rule-kind.non-object-child',
      rules: subtree({ a: { b: 42 } }),
      expectation: { verdict: 'REJECTED', error: "Expected '{'." },
    },
    {
      description: 'CON-6: child node whose value is an array ([{".read": true}])',
      construct: 'rtdb.rule-kind.non-object-child',
      rules: subtree({ a: { b: [{ '.read': true }] } }),
      expectation: { verdict: 'REJECTED', error: "Expected '{'." },
    },
    {
      description: 'CON-6: .read rule whose value is an array ([true])',
      construct: 'rtdb.rule-kind.non-expression-value',
      rules: subtree({ a: { '.read': [true] } }),
      expectation: {
        verdict: 'REJECTED',
        error: "Invalid rule expression.  Expected 'true', 'false', or an expression string.",
      },
    },
  ],
};
