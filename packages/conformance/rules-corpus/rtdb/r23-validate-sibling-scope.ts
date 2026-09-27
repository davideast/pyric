/**
 * ─── r23-validate-sibling-scope ───────────────────────────────────────────
 * WHICH nodes' `.validate` rules does a write run, beyond the write location
 * and its ancestors? Each room has three validated children: `title` (a
 * string), `count` (may only grow by one: `newData.val() == data.val() + 1`)
 * and `tag` (a number). `count` fails whenever it is evaluated without
 * changing, and a seeded string `tag` fails whenever it is evaluated at all.
 *
 *   - A set of `title`, an update of `title` alone, a multi-path update of two
 *     rooms' titles, and a deletion of `title` leave `count` and `tag`
 *     unwritten, next to a `count` that did not change and a stored `tag` that
 *     fails its own rule, in the same room or another room.
 *   - A set of the whole room, and an update of `count` or `tag` alone, write
 *     those children with the value they already hold.
 *   - Controls: `count` written one higher, and two higher.
 *   - Under `docs`, `meta` requires its sibling `content`. A set, an update,
 *     and a multi-path update delete `content` and leave `meta` unwritten; a
 *     set of the doc carries `meta` without `content`.
 *
 * Production validates only the nodes a write carries: the unwritten siblings
 * are never evaluated, and a carried node is evaluated even when its value is
 * unchanged.
 *
 * Covers: .validate scope for set, update, and multi-path update.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'a write must not be denied by the `.validate` rule of a sibling node it does not write, and a node the write does carry must still run its `.validate`.',
  provenance:
    'Authored to settle which `.validate` rules a write runs beyond its ancestors. Expectations are the production allow/deny verdicts recorded by the deploy-observe-restore capture in observations/rtdb-rules/rules-rtdb-r23-validate-sibling-scope.json.',
  rules: JSON.stringify({
    rooms: {
      $room: {
        '.write': 'auth != null',
        title: { '.validate': 'newData.isString()' },
        count: { '.validate': 'newData.val() == data.val() + 1' },
        tag: { '.validate': 'newData.isNumber()' },
      },
    },
    docs: {
      $doc: {
        '.write': 'auth != null',
        meta: { '.validate': "newData.parent().child('content').exists()" },
        content: { '.validate': 'newData.isString()' },
      },
    },
  }),
  cases: [
    { description: 'set of title next to a count that did not change', expectation: 'ALLOW', operation: 'write', opPath: '/rooms/r1/title', authPresent: true, newData: 'lobby', seed: { '/rooms/r1/count': 1 } },
    { description: 'set of title next to a stored tag that fails its validate', expectation: 'ALLOW', operation: 'write', opPath: '/rooms/r1/title', authPresent: true, newData: 'lobby', seed: { '/rooms/r1/tag': 'bad' } },
    { description: 'set of title next to another room whose stored tag fails its validate', expectation: 'ALLOW', operation: 'write', opPath: '/rooms/r1/title', authPresent: true, newData: 'lobby', seed: { '/rooms/r2/tag': 'bad' } },
    { description: 'update of title alone next to an unchanged count and a failing tag', expectation: 'ALLOW', operation: 'update', opPath: '/rooms/r1', authPresent: true, newData: { title: 'lobby' }, seed: { '/rooms/r1/count': 1, '/rooms/r1/tag': 'bad' } },
    { description: 'multi-path update of two titles next to an unchanged count and a failing tag', expectation: 'ALLOW', operation: 'update', opPath: '/rooms', authPresent: true, newData: { 'r1/title': 'a', 'r2/title': 'b' }, seed: { '/rooms/r1/count': 1, '/rooms/r2/tag': 'bad' } },
    { description: 'deletion of title next to a count that did not change', expectation: 'ALLOW', operation: 'write', opPath: '/rooms/r1/title', authPresent: true, newData: null, seed: { '/rooms/r1/title': 'lobby', '/rooms/r1/count': 1 } },
    { description: 'set of the room carrying count with its stored value', expectation: 'DENY', operation: 'write', opPath: '/rooms/r1', authPresent: true, newData: { title: 'lobby', count: 1 }, seed: { '/rooms/r1/count': 1 } },
    { description: 'set of the room carrying tag with its stored failing value', expectation: 'DENY', operation: 'write', opPath: '/rooms/r1', authPresent: true, newData: { title: 'lobby', tag: 'bad' }, seed: { '/rooms/r1/tag': 'bad' } },
    { description: 'update of count alone with its stored value', expectation: 'DENY', operation: 'update', opPath: '/rooms/r1', authPresent: true, newData: { count: 1 }, seed: { '/rooms/r1/count': 1 } },
    { description: 'update of tag alone with its stored failing value', expectation: 'DENY', operation: 'update', opPath: '/rooms/r1', authPresent: true, newData: { tag: 'bad' }, seed: { '/rooms/r1/tag': 'bad' } },
    { description: 'set of count one higher', expectation: 'ALLOW', operation: 'write', opPath: '/rooms/r1/count', authPresent: true, newData: 2, seed: { '/rooms/r1/count': 1 } },
    { description: 'set of count two higher', expectation: 'DENY', operation: 'write', opPath: '/rooms/r1/count', authPresent: true, newData: 3, seed: { '/rooms/r1/count': 1 } },
    { description: 'deletion of content that an unwritten sibling meta requires', expectation: 'ALLOW', operation: 'write', opPath: '/docs/d1/content', authPresent: true, newData: null, seed: { '/docs/d1': { meta: 'info', content: 'hello' } } },
    { description: 'update deleting content that an unwritten sibling meta requires', expectation: 'ALLOW', operation: 'update', opPath: '/docs/d1', authPresent: true, newData: { content: null }, seed: { '/docs/d1': { meta: 'info', content: 'hello' } } },
    { description: 'multi-path update from the mount deleting content that an unwritten sibling meta requires', expectation: 'ALLOW', operation: 'update', opPath: '/', authPresent: true, newData: { 'docs/d1/content': null }, seed: { '/docs/d1': { meta: 'info', content: 'hello' } } },
    { description: 'set of the doc carrying meta without content', expectation: 'DENY', operation: 'write', opPath: '/docs/d1', authPresent: true, newData: { meta: 'info' }, seed: { '/docs/d1': { meta: 'info', content: 'hello' } } },
  ],
};
