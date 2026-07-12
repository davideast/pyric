/**
 * ─── r13-cross-tree-lookup ────────────────────────────────────────────────
 * A chat room whose message rule authorizes against a SIBLING SUBTREE — the
 * membership list — reached by walking up from the rule's own node:
 * `data.parent().parent().child('members').hasChild(auth.uid)`. A member may
 * post; a non-member may not. Reads of a room's messages are additionally
 * gated on the absence of a global maintenance flag at the DATABASE ROOT
 * (`root.child('__pyric_maintenance')`), and `/maintenance` is the flag's
 * mirror image — readable only WHILE the flag is set, so it denies.
 *
 * ROOT IS THE DATABASE ROOT, NOT THE MOUNT. Every scenario mounts under a
 * run-scoped namespace in production and directly under the mock root in the
 * simulator, so the two `root` trees are not the same tree. The only `root`
 * assertion that means the same thing on both sides is the ABSENCE of a
 * top-level key — which is exactly what the maintenance-flag rules assert, and
 * what production confirms by allowing the read (flag absent) and denying
 * `/maintenance` (flag absent).
 *
 * `/unruled` carries no rule at any level: production denies it because RTDB
 * grants nothing by default. That case is this scenario's DENY-BY-DEFAULT
 * proof, and the registry row citing this capture carries
 * `rtdb.semantic.deny-by-default` in its construct scope (the coverage analyzer
 * attributes tokens, so a semantic can only be credited by the row that proves
 * it).
 *
 * Expectations are the PRODUCTION verdicts recorded by the deploy-observe-
 * restore capture
 * (observations/rtdb-rules/rules-rtdb-r13-cross-tree-lookup.json).
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'a message rule that authorizes against the room membership list two levels up (data.parent().parent().child(...)) — production must resolve the same sibling subtree the simulator does — plus a root-level maintenance flag and a path with no rule at all (deny by default).',
  provenance:
    'Authored to exercise the rtdb bindings `root` and the snapshot method `parent()` against a real membership lookup, then captured against the live oracle database; expectations are the captured production verdicts.',
  rules: JSON.stringify({
    rooms: {
      $roomId: {
        members: {
          '.read': 'auth != null',
          '.write': 'auth != null',
        },
        messages: {
          '.read': "auth != null && !root.child('__pyric_maintenance').exists()",
          $msgId: {
            '.write': "auth != null && data.parent().parent().child('members').hasChild(auth.uid)",
            '.validate': "newData.hasChildren(['text'])",
          },
        },
      },
    },
    maintenance: {
      '.read': "root.child('__pyric_maintenance').exists()",
    },
  }),
  cases: [
    {
      description: 'member posts a message',
      expectation: 'ALLOW',
      operation: 'write',
      opPath: '/rooms/r1/messages/m1',
      authPresent: true,
      seed: { '/rooms/r1/members/<UID>': true },
      newData: { text: 'hello' },
    },
    {
      description: 'non-member post denied (sibling membership lookup)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/rooms/r2/messages/m1',
      authPresent: true,
      seed: { '/rooms/r2/members/some-other-uid': true },
      newData: { text: 'hello' },
    },
    {
      description: 'member reads the room messages (maintenance flag absent at the root)',
      expectation: 'ALLOW',
      operation: 'read',
      opPath: '/rooms/r1/messages',
      authPresent: true,
      seed: { '/rooms/r1/members/<UID>': true },
    },
    {
      description: 'anonymous read of room messages denied',
      expectation: 'DENY',
      operation: 'read',
      opPath: '/rooms/r1/messages',
      authPresent: false,
    },
    {
      description: 'joining a room writes the membership entry',
      expectation: 'ALLOW',
      operation: 'write',
      opPath: '/rooms/r3/members/<UID>',
      authPresent: true,
      newData: true,
    },
    {
      description: 'maintenance node read denied (flag absent at the root)',
      expectation: 'DENY',
      operation: 'read',
      opPath: '/maintenance',
      authPresent: true,
    },
    {
      description: 'read of a path with no rule denied (deny by default)',
      expectation: 'DENY',
      operation: 'read',
      opPath: '/unruled',
      authPresent: true,
    },
  ],
};
