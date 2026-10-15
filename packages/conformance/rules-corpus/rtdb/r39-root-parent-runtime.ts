/**
 * ─── r39-root-parent-runtime ──────────────────────────────────────────────
 * Runtime behavior of `root.parent()` when it appears in a rule expression
 * that production's compiler accepts at deploy time.
 *
 * Direct `root.parent().exists()` is accepted at deploy time, and mixed-branch
 * ternaries such as `(true ? root.parent() : null) == null` or
 * `((true ? root.parent() : 1) == 1) || true` also compile. At evaluation time,
 * `root` has no parent snapshot: calling `root.parent()` fails the rule
 * expression rather than returning `null` and letting `== null` or `|| true`
 * grant access.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'calling parent() on the root snapshot must match production: if root.parent() fails the rule expression, neither == null nor || true can evaluate to ALLOW.',
  provenance:
    'Authored from 2026-10-15 bug hunt (COV-1) to pin runtime root.parent() evaluation against production. Captured by deploy-observe-restore on 2026-10-15 in observations/rtdb-rules/rules-rtdb-r39-root-parent-runtime.json.',
  rules: JSON.stringify({
    eqNull: { '.read': '(true ? root.parent() : null) == null' },
    neqNullOrTrue: { '.read': '(true ? root.parent() : null) != null || true' },
    eqOneOrTrue: { '.read': '((true ? root.parent() : 1) == 1) || true' },
    neqOne: { '.read': '(true ? root.parent() : 1) != 1' },
    lengthOrTrue: { '.read': "(true ? root.parent() : '').length == null || true" },
    existsOrTrue: { '.read': 'root.parent().exists() || true' },
    nested: {
      child: {
        '.read': '(true ? data.parent() : null).exists()',
      },
    },
  }),
  cases: [
    {
      description: 'COV-1: (true ? root.parent() : null) == null',
      expectation: 'DENY',
      operation: 'read',
      opPath: '/eqNull',
      authPresent: true,
    },
    {
      description: 'COV-1: (true ? root.parent() : null) != null || true',
      expectation: 'DENY',
      operation: 'read',
      opPath: '/neqNullOrTrue',
      authPresent: true,
    },
    {
      description: 'COV-1: ((true ? root.parent() : 1) == 1) || true',
      expectation: 'DENY',
      operation: 'read',
      opPath: '/eqOneOrTrue',
      authPresent: true,
    },
    {
      description: 'COV-1: (true ? root.parent() : 1) != 1',
      expectation: 'DENY',
      operation: 'read',
      opPath: '/neqOne',
      authPresent: true,
    },
    {
      description: "COV-1: (true ? root.parent() : '').length == null || true",
      expectation: 'DENY',
      operation: 'read',
      opPath: '/lengthOrTrue',
      authPresent: true,
    },
    {
      description: 'COV-1: root.parent().exists() || true',
      expectation: 'DENY',
      operation: 'read',
      opPath: '/existsOrTrue',
      authPresent: true,
    },
    {
      description: 'COV-1: control non-root data.parent().exists() in ternary',
      expectation: 'ALLOW',
      operation: 'read',
      opPath: '/nested/child',
      authPresent: true,
      seed: { '/nested/child': 'v' },
    },
  ],
};
