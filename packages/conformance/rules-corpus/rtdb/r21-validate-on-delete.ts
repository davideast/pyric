/**
 * ─── r21-validate-on-delete ───────────────────────────────────────────────
 * Writes that leave a node with a `.validate` rule empty: deleting the node,
 * writing `{}` to it, and deleting the only child of a parent that requires
 * children. Pins whether `.validate` runs for a node whose new value is null,
 * next to deletions that leave the node non-null and fail its `.validate`.
 *
 * Covers: .validate on deletion.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'a delete that production allows must not be denied by a `.validate` rule the simulator runs on a null value, and a partial delete production denies must stay denied.',
  provenance:
    'Authored to settle `.validate` on writes that delete a node. Expectations are the production allow/deny verdicts recorded by the deploy-observe-restore capture in observations/rtdb-rules/rules-rtdb-r21-validate-on-delete.json.',
  rules: JSON.stringify({
    nodes: {
      $nodeId: {
        '.write': 'auth != null',
        '.validate': "newData.hasChildren(['reqA', 'reqB'])",
        reqA: { '.validate': 'newData.isString()' },
        reqB: { '.validate': 'newData.isNumber()' },
      },
    },
    parent: {
      '.write': 'auth != null',
      '.validate': 'newData.hasChildren()',
    },
  }),
  cases: [
    { description: 'writing an empty object deletes the node', expectation: 'ALLOW', operation: 'write', opPath: '/nodes/emptied', authPresent: true, newData: {}, seed: { '/nodes/emptied': { reqA: 'ok', reqB: 10 } } },
    { description: 'writing null deletes the node', expectation: 'ALLOW', operation: 'write', opPath: '/nodes/nulled', authPresent: true, newData: null, seed: { '/nodes/nulled': { reqA: 'ok', reqB: 10 } } },
    { description: 'deleting one required child leaves the node failing its validate', expectation: 'DENY', operation: 'write', opPath: '/nodes/partial/reqB', authPresent: true, newData: null, seed: { '/nodes/partial': { reqA: 'ok', reqB: 10 } } },
    { description: 'writing the node without a required child fails its validate', expectation: 'DENY', operation: 'write', opPath: '/nodes/missing', authPresent: true, newData: { reqA: 'ok' }, seed: { '/nodes/missing': { reqA: 'ok', reqB: 10 } } },
    { description: 'deleting the only child of a parent that requires children', expectation: 'ALLOW', operation: 'write', opPath: '/parent/container', authPresent: true, newData: null, seed: { '/parent/container': { child1: true } } },
    { description: 'deleting one of two children of a parent that requires children', expectation: 'ALLOW', operation: 'write', opPath: '/parent/first', authPresent: true, newData: null, seed: { '/parent/first': true, '/parent/second': true } },
  ],
};
