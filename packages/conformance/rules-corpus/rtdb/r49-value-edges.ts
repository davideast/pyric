/**
 * ─── r49-value-edges ──────
 * Runtime values no observation covers:
 *
 *   - SP-4: `query` in a .write rule. Production accepts it at deploy
 *     (rtdb-rules-type-check probe 'query-in-write') and populates
 *     query.orderByKey as false on a plain read (r30, r45). pyric evaluates
 *     `query` as null in a write, so !query.orderByKey and
 *     query.orderByKey == false deny.
 *   - SP-5: a member of `auth` read with nobody signed in. pyric reads null, so
 *     auth.token.admin != true and auth.uid == null grant a signed-out read.
 *     Belief: production fails the rule, as it does for an index on null (r40).
 *   - SP-6: child()/hasChild() with a runtime key production would never accept
 *     as a path ('a.b', '', '.priority'). pyric looks 'a.b' up as a missing child,
 *     returns the node itself for '', and reads a priority as a child.
 *   - coverage: .length of a string of astral characters (pyric counts UTF-16
 *     code units, 2 per emoji). Belief: production agrees (JVM strings).
 *
 * Captured 2026-10-26. Production allows both SP-4 writes: `query` in a
 * .write reads as on a plain read (orderByKey false), so pyric's DENY is a
 * divergence. Production agrees with pyric on every other case, refuting SP-5
 * and SP-6: auth members read null when signed out, child('a.b') is a missing
 * child, child('') is the node itself, and hasChild('.priority') is true on a
 * prioritized leaf.
 */
import type { RtdbScenarioRecord } from './types.ts';

const keyed = '!data.child(newData.child(\'k\').val()).exists()';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'query in a write, auth members when signed out, and child() keys that are not valid paths are evaluated by pyric with values no production observation confirms.',
  provenance:
    'Drafted from the 2026-10-26 RTDB simulator-vs-production hunt (SP-4, SP-5, SP-6). Captured by deploy-observe-restore against pyric-oracle-rtdb on 2026-10-26 in observations/rtdb-rules/rules-rtdb-r49-value-edges.json.',
  rules: JSON.stringify({
    notkey: { '.write': '!query.orderByKey' },
    keyfalse: { '.write': 'query.orderByKey == false' },
    nolimit: { '.write': 'query.limitToFirst == null' },
    notadmin: { '.read': 'auth.token.admin != true' },
    uidnull: { '.read': 'auth.uid == null' },
    signedout: { '.read': 'auth == null' },
    keyed: { '.write': `auth != null && ${keyed}` },
    selfkey: { '.write': "auth != null && data.child(newData.child('k').val()).exists()" },
    prio: { '.read': 'data.hasChild(auth.token.k)' },
    short: { '.write': 'auth != null', '.validate': 'newData.isString() && newData.val().length <= 3' },
  }),
  cases: [
    { description: 'SP-4: !query.orderByKey in a .write', expectation: 'ALLOW', operation: 'write', opPath: '/notkey', authPresent: true, newData: 1 },
    { description: 'SP-4: query.orderByKey == false in a .write', expectation: 'ALLOW', operation: 'write', opPath: '/keyfalse', authPresent: true, newData: 1 },
    { description: 'SP-4 control: query.limitToFirst == null in a .write', expectation: 'ALLOW', operation: 'write', opPath: '/nolimit', authPresent: true, newData: 1 },
    { description: 'SP-5: auth.token.admin != true signed out', expectation: 'ALLOW', operation: 'read', opPath: '/notadmin', authPresent: false },
    { description: 'SP-5: auth.uid == null signed out', expectation: 'ALLOW', operation: 'read', opPath: '/uidnull', authPresent: false },
    { description: 'SP-5 control: auth == null signed out', expectation: 'ALLOW', operation: 'read', opPath: '/signedout', authPresent: false },
    { description: 'SP-5 control: auth.token.admin != true for an anonymous user', expectation: 'ALLOW', operation: 'read', opPath: '/notadmin', authPresent: true },
    { description: "SP-6: child() of a key holding a dot ('a.b') under !exists()", expectation: 'ALLOW', operation: 'write', opPath: '/keyed', authPresent: true, newData: { k: 'a.b' } },
    { description: "SP-6 control: child() of a plain key ('ab') under !exists()", expectation: 'ALLOW', operation: 'write', opPath: '/keyed', authPresent: true, newData: { k: 'ab' } },
    { description: "SP-6: child('') of an existing node", expectation: 'ALLOW', operation: 'write', opPath: '/selfkey', authPresent: true, newData: { k: '' }, seed: { '/selfkey/v': 1 } },
    { description: "SP-6: hasChild('.priority') on a prioritized leaf", expectation: 'ALLOW', operation: 'read', opPath: '/prio', authPresent: true, claims: { k: '.priority' }, seed: { '/prio': { '.value': 1, '.priority': 3 } } },
    { description: 'coverage: length of three emoji under length <= 3', expectation: 'DENY', operation: 'write', opPath: '/short', authPresent: true, newData: '😀😀😀' },
    { description: 'coverage control: length of three letters under length <= 3', expectation: 'ALLOW', operation: 'write', opPath: '/short', authPresent: true, newData: 'abc' },
  ],
};
