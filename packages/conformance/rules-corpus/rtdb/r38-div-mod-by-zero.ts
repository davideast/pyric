/**
 * ─── r38-div-mod-by-zero ──────────────────────────────────────────────────
 * Runtime division (`/`) and modulo (`%`) when the divisor is `0` read from
 * stored or written data.
 *
 * In JavaScript, `10 / 0` evaluates to `Infinity` (`Infinity > 100 === true`)
 * and `0 / 0` or `10 % 0` evaluates to `NaN` (`!(NaN == 0) === true`).
 * Production denies `10 / 0 > 100` while allowing equality comparisons with
 * `0` under `|| true` or `!(... == 0)`.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'division or modulo by a runtime zero divisor must match production rather than evaluating to JavaScript Infinity or NaN and granting upper-bound or != 0 checks.',
  provenance:
    'Authored from 2026-10-15 bug hunt (COV-2) to pin runtime division and modulo by zero against production. Captured by deploy-observe-restore on 2026-10-15 in observations/rtdb-rules/rules-rtdb-r38-div-mod-by-zero.json.',
  rules: JSON.stringify({
    divGt: { '.write': "newData.val() / data.child('d').val() > 100" },
    divOrTrue: { '.write': "newData.val() / data.child('d').val() == 0 || true" },
    divNotEq: { '.write': "!(newData.val() / data.child('d').val() == 0)" },
    zeroDivZeroOrTrue: { '.write': "0 / data.child('d').val() == 0 || true" },
    modOrTrue: { '.write': "newData.val() % data.child('d').val() == 0 || true" },
    modNotEq: { '.write': "!(newData.val() % data.child('d').val() == 0)" },
  }),
  cases: [
    {
      description: 'COV-2: positive number divided by seeded 0 compared with > 100 (10 / 0 > 100)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/divGt',
      authPresent: true,
      seed: { '/divGt/d': 0 },
      newData: 10,
    },
    {
      description: 'COV-2: positive number divided by seeded 0 under == 0 || true (10 / 0 == 0 || true)',
      expectation: 'ALLOW',
      operation: 'write',
      opPath: '/divOrTrue',
      authPresent: true,
      seed: { '/divOrTrue/d': 0 },
      newData: 10,
    },
    {
      description: 'COV-2: positive number divided by seeded 0 under !(X == 0) (!(10 / 0 == 0))',
      expectation: 'ALLOW',
      operation: 'write',
      opPath: '/divNotEq',
      authPresent: true,
      seed: { '/divNotEq/d': 0 },
      newData: 10,
    },
    {
      description: 'COV-2: 0 divided by seeded 0 under == 0 || true (0 / 0 == 0 || true)',
      expectation: 'ALLOW',
      operation: 'write',
      opPath: '/zeroDivZeroOrTrue',
      authPresent: true,
      seed: { '/zeroDivZeroOrTrue/d': 0 },
      newData: 0,
    },
    {
      description: 'COV-2: positive number modulo seeded 0 under == 0 || true (10 % 0 == 0 || true)',
      expectation: 'ALLOW',
      operation: 'write',
      opPath: '/modOrTrue',
      authPresent: true,
      seed: { '/modOrTrue/d': 0 },
      newData: 10,
    },
    {
      description: 'COV-2: positive number modulo seeded 0 under !(X == 0) (!(10 % 0 == 0))',
      expectation: 'ALLOW',
      operation: 'write',
      opPath: '/modNotEq',
      authPresent: true,
      seed: { '/modNotEq/d': 0 },
      newData: 10,
    },
    {
      description: 'COV-2: control division by non-zero divisor (500 / 2 > 100)',
      expectation: 'ALLOW',
      operation: 'write',
      opPath: '/divGt',
      authPresent: true,
      seed: { '/divGt/d': 2 },
      newData: 500,
    },
    {
      description: 'COV-2: control modulo by non-zero divisor (10 % 3 != 0 via !(X == 0))',
      expectation: 'ALLOW',
      operation: 'write',
      opPath: '/modNotEq',
      authPresent: true,
      seed: { '/modNotEq/d': 3 },
      newData: 10,
    },
  ],
};
