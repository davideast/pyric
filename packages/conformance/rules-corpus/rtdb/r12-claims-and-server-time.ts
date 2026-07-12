/**
 * ─── r12-claims-and-server-time ───────────────────────────────────────────
 * An append-only audit log gated on the ID-TOKEN CLAIMS and on SERVER TIME:
 *   - `/entries/$entryId` is readable by a session whose
 *     `auth.token.firebase.sign_in_provider` is `anonymous` (the provider gate),
 *     and writable once — `!data.exists()` makes the log append-only;
 *   - an entry's `at` must be a whole millisecond stamp not in the future
 *     (`newData.val() <= now`), and its `by` must be the writer's own uid;
 *   - `/verified` is readable only by a session carrying the
 *     `email_verified` claim, which an anonymous session does not have;
 *   - `/adminOnly` is readable only by a session carrying an `admin` custom
 *     claim, read through the INDEX operator (`auth.token['admin']`) — the one
 *     form of `[]` production accepts. (Indexing a snapshot's value is
 *     rejected: `data.val()['plan']` → `No such method/property 'plan'`; an
 *     array literal in an expression is rejected outright. `.child()` is the
 *     only way into a snapshot.)
 *
 * The claim rules are deliberately opposite: the provider gate is a claim the
 * captured session DOES carry (so it allows), while `email_verified` and
 * `admin` are claims it does NOT (so they deny). Every `auth.token` read is
 * therefore decided by production, not merely parsed.
 *
 * Expectations are the PRODUCTION verdicts recorded by the deploy-observe-
 * restore capture
 * (observations/rtdb-rules/rules-rtdb-r12-claims-and-server-time.json).
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'auth.token claims and the server-time binding `now` decide a real append-only log: the provider claim the anonymous session carries grants the read, the email_verified and admin claims it lacks deny two others, a future timestamp is rejected against now, and an existing entry cannot be overwritten.',
  provenance:
    'Authored to exercise the rtdb bindings `auth.token` / `now` and the index operator in its production-accepted form (`auth.token[...]`), then captured against the live oracle database; expectations are the captured production verdicts.',
  rules: JSON.stringify({
    entries: {
      $entryId: {
        '.read': "auth.token.firebase.sign_in_provider === 'anonymous'",
        '.write': 'auth != null && !data.exists()',
        '.validate': "newData.hasChildren(['at', 'by'])",
        at: { '.validate': 'newData.isNumber() && newData.val() > 0 && newData.val() <= now' },
        by: { '.validate': 'newData.val() === auth.uid' },
      },
    },
    verified: {
      '.read': 'auth.token.email_verified === true',
    },
    adminOnly: {
      '.read': "auth.token['admin'] === true",
    },
  }),
  cases: [
    {
      description: 'entry read allowed by the provider claim',
      expectation: 'ALLOW',
      operation: 'read',
      opPath: '/entries/e1',
      authPresent: true,
    },
    {
      description: 'entry read denied when signed out (no token)',
      expectation: 'DENY',
      operation: 'read',
      opPath: '/entries/e1',
      authPresent: false,
    },
    {
      description: 'entry stamped in the past allowed (now)',
      expectation: 'ALLOW',
      operation: 'write',
      opPath: '/entries/e1',
      authPresent: true,
      newData: { at: 1, by: '<UID>' },
    },
    {
      description: 'entry stamped in the future denied (now)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/entries/e2',
      authPresent: true,
      newData: { at: 32503680000000, by: '<UID>' },
    },
    {
      description: 'entry attributed to another uid denied',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/entries/e3',
      authPresent: true,
      newData: { at: 1, by: 'some-other-uid' },
    },
    {
      description: 'read of the verified-only node denied (missing email_verified claim)',
      expectation: 'DENY',
      operation: 'read',
      opPath: '/verified',
      authPresent: true,
    },
    {
      description: 'read of the admin-only node denied (missing admin claim, read by index)',
      expectation: 'DENY',
      operation: 'read',
      opPath: '/adminOnly',
      authPresent: true,
    },
    {
      description: 'overwriting an existing entry denied (append-only)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/entries/e4',
      authPresent: true,
      mockData: { at: 1, by: '<UID>' },
      newData: { at: 2, by: '<UID>' },
    },
  ],
};
