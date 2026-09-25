/**
 * ─── r19-literal-and-wildcard-siblings ────────────────────────────────────
 * A `$wildcard` child next to a literal sibling, as in
 * `items: { $id: {...}, special: {...} }`. Pins which rules apply to a path the
 * literal names: whether the wildcard's `.read`/`.write` also apply there, in
 * either declaration order, and whether the wildcard's `.validate` runs for it.
 *
 * Covers: wildcard and literal sibling matching.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'the simulator decides which sibling rules apply to a literal key; a wrong choice grants reads or writes that production denies, or denies writes production allows.',
  provenance:
    'Authored to settle literal-versus-wildcard sibling matching. Expectations are the production allow/deny verdicts recorded by the deploy-observe-restore capture in observations/rtdb-rules/rules-rtdb-r19-literal-and-wildcard-siblings.json.',
  rules: JSON.stringify({
    literalfirst: {
      special: { '.read': 'false', '.write': 'false' },
      $id: { '.read': 'true', '.write': 'true' },
    },
    wildcardfirst: {
      $id: { '.read': 'true', '.write': 'true' },
      special: { '.read': 'false', '.write': 'false' },
    },
    literalgrants: {
      special: { '.read': 'true', '.write': 'true' },
      $id: { '.read': 'false', '.write': 'false' },
    },
    validate: {
      '.write': 'true',
      title: { '.validate': 'true' },
      $other: { '.validate': 'false' },
    },
  }),
  cases: [
    { description: 'literal first: read of the literal key', expectation: 'DENY', operation: 'read', opPath: '/literalfirst/special', authPresent: true },
    { description: 'literal first: write of the literal key', expectation: 'DENY', operation: 'write', opPath: '/literalfirst/special', authPresent: true, newData: 'x' },
    { description: 'literal first: read of another key', expectation: 'ALLOW', operation: 'read', opPath: '/literalfirst/other', authPresent: true },
    { description: 'wildcard first: read of the literal key', expectation: 'DENY', operation: 'read', opPath: '/wildcardfirst/special', authPresent: true },
    { description: 'wildcard first: write of the literal key', expectation: 'DENY', operation: 'write', opPath: '/wildcardfirst/special', authPresent: true, newData: 'x' },
    { description: 'wildcard first: write of another key', expectation: 'ALLOW', operation: 'write', opPath: '/wildcardfirst/other', authPresent: true, newData: 'x' },
    { description: 'literal grants: read of the literal key', expectation: 'ALLOW', operation: 'read', opPath: '/literalgrants/special', authPresent: true },
    { description: 'literal grants: read of another key', expectation: 'DENY', operation: 'read', opPath: '/literalgrants/other', authPresent: true },
    { description: 'wildcard validate does not run for the literal key', expectation: 'ALLOW', operation: 'write', opPath: '/validate/title', authPresent: true, newData: 'x' },
    { description: 'wildcard validate runs for another key', expectation: 'DENY', operation: 'write', opPath: '/validate/other', authPresent: true, newData: 'x' },
  ],
};
