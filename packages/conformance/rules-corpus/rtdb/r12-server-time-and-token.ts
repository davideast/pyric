/**
 * ─── r12-server-time-and-token ────────────────────────────────────────────
 * The two request-scoped bindings r1-r8 never touched: `now` (the server's
 * evaluation-time clock in milliseconds) and `auth.token` (the decoded ID-token
 * claims), plus the `[]` subscript that reads a claim by key.
 *
 * `now` is not frozen, so the cases straddle it by a wide margin rather than
 * probing near it: a timestamp fixed in the past is always `<= now` and one fixed
 * far in the future never is, which makes both verdicts stable no matter when the
 * capture runs.
 *
 * The subscript form is the reason `/anonymoussubscript` exists alongside
 * `/anonymousonly`: production accepts `auth.token['firebase']['sign_in_provider']`
 * (a map indexed by key) but REJECTS the same subscript applied to a snapshot value
 * such as `newData.val()['kind']`, which fails to compile with "No such
 * method/property". The subscript is therefore a map accessor, not a general
 * indexing operator, and only the map form belongs in a corpus that must deploy.
 *
 * Covers: now, auth.token, and the `[]` subscript.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'rules routinely gate writes on the server clock and on the sign-in provider carried in the ID token, and the token is also the only receiver production accepts the `[]` subscript on — the simulator must resolve `now`, the dotted claim path, and the indexed claim path the same way production does.',
  provenance:
    'Authored to close the rules-language construct gaps left by r1-r8, which bound only `auth`/`auth.uid`/`data`/`newData`. The subscript receiver was chosen after production rejected `newData.val()[...]` at ruleset compile time and accepted `auth.token[...]`. Expectations are the production allow/deny verdicts recorded by the deploy-observe-restore capture in observations/rtdb-rules/rules-rtdb-r12-server-time-and-token.json.',
  rules: JSON.stringify({
    '.read': 'auth != null',
    createdat: {
      '.write': 'auth != null',
      '.validate': 'newData.isNumber() && newData.val() <= now',
    },
    anonymousonly: {
      '.write': "auth.token.firebase.sign_in_provider == 'anonymous'",
    },
    anonymoussubscript: {
      '.write': "auth.token['firebase']['sign_in_provider'] == 'anonymous'",
    },
    passwordonly: {
      '.write': "auth.token.firebase.sign_in_provider == 'password'",
    },
  }),
  cases: [
    { description: 'past timestamp is at or before now', expectation: 'ALLOW', operation: 'write', opPath: '/createdat', authPresent: true, newData: 1000000000000 },
    { description: 'far-future timestamp is after now', expectation: 'DENY', operation: 'write', opPath: '/createdat', authPresent: true, newData: 99999999999999 },
    { description: 'anonymous provider claim allows the dotted token path', expectation: 'ALLOW', operation: 'write', opPath: '/anonymousonly', authPresent: true, newData: 'ok' },
    { description: 'anonymous provider claim allows the subscripted token path', expectation: 'ALLOW', operation: 'write', opPath: '/anonymoussubscript', authPresent: true, newData: 'ok' },
    { description: 'anonymous provider claim does not satisfy a password gate', expectation: 'DENY', operation: 'write', opPath: '/passwordonly', authPresent: true, newData: 'ok' },
    { description: 'signed-out request has no token claim to read', expectation: 'DENY', operation: 'write', opPath: '/anonymousonly', authPresent: false, newData: 'ok' },
    { description: 'auth-gated read allowed', expectation: 'ALLOW', operation: 'read', opPath: '/createdat', authPresent: true },
  ],
};
