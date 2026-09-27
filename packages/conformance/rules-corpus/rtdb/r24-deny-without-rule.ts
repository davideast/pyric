/**
 * ─── r24-deny-without-rule ────────────────────────────────────────────────
 * A request is denied when no `.read` or `.write` rule on its path grants it,
 * including when the deepest rules node on the path carries no rule of the
 * request's kind. The subtree root sets `.read` and `.write` to false. Under
 * `rooms/$id`, the node `n` has only a `.validate`; `rooms` itself has only
 * children; under `reports/$id` there is only a `.read`.
 *
 *   - A write to `n` that the room `.write` rejects, and one it grants.
 *   - A write under a node that has only a `.read`.
 *   - A read and a write of `rooms`, which has only children.
 *   - Controls: a read granted by the room `.read`, directly and through
 *     the cascade to `n`.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'a request no .read or .write rule grants is denied even where the deepest rules node on the path has only children, only a .validate, or only the other operation\'s rule, so the simulator must deny it rather than report that it found no rule.',
  provenance:
    'Authored to pin denial without a granting rule against production directly. Expectations are the production allow/deny verdicts recorded by the deploy-observe-restore capture in observations/rtdb-rules/rules-rtdb-r24-deny-without-rule.json.',
  rules: JSON.stringify({
    '.read': false,
    '.write': false,
    rooms: {
      $id: {
        '.read': 'auth != null',
        '.write': "auth != null && newData.child('n').val() < 10",
        n: { '.validate': 'newData.isNumber()' },
      },
    },
    reports: {
      $id: { '.read': 'auth != null' },
    },
  }),
  cases: [
    { description: 'write under a node with only .validate, room .write false', expectation: 'DENY', operation: 'write', opPath: '/rooms/r1/n', authPresent: true, newData: 50 },
    { description: 'write under a node with only .validate, room .write true', expectation: 'ALLOW', operation: 'write', opPath: '/rooms/r1/n', authPresent: true, newData: 5 },
    { description: 'write under a node with only .read', expectation: 'DENY', operation: 'write', opPath: '/reports/x', authPresent: true, newData: 1 },
    { description: 'read of a node with only children', expectation: 'DENY', operation: 'read', opPath: '/rooms', authPresent: true },
    { description: 'write of a node with only children', expectation: 'DENY', operation: 'write', opPath: '/rooms', authPresent: true, newData: { r1: { n: 1 } } },
    { description: 'read granted by the room .read', expectation: 'ALLOW', operation: 'read', opPath: '/rooms/r1', authPresent: true },
    { description: 'read under a node with only .validate, granted by the room .read', expectation: 'ALLOW', operation: 'read', opPath: '/rooms/r1/n', authPresent: true },
  ],
};
