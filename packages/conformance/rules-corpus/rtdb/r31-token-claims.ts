/**
 * ─── r31-token-claims ─────────────────────────────────────────────────────
 * Custom claims on `auth.token`. The signed-in cases sign in with a custom
 * token minted for each case's claims, so the claims arrive in the ID token as
 * production issues it:
 *
 *   - a boolean, a string, a number and a nested object claim,
 *   - a claim the token does not carry,
 *   - `auth.token.firebase.sign_in_provider` and `auth.provider` for a
 *     custom-token sign-in,
 *   - and the same gates for an anonymous user and a signed-out request.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'role and tenant gates read custom claims from auth.token, so the simulator must expose the claims a custom token carries with their types, and read an absent claim the way production does.',
  provenance:
    'Authored to pin custom claims on the RTDB auth.token variable. Expectations are the production allow/deny verdicts recorded by the deploy-observe-restore capture in observations/rtdb-rules/rules-rtdb-r31-token-claims.json.',
  rules: JSON.stringify({
    admin: { '.write': 'auth.token.admin == true' },
    role: { '.write': "auth.token.role == 'editor'" },
    level: { '.write': 'auth.token.level >= 3' },
    nested: { '.write': "auth.token.org.tier == 'gold'" },
    absent: { '.write': 'auth.token.admin == null' },
    provider: { '.write': "auth.token.firebase.sign_in_provider == 'custom'" },
    authprovider: { '.write': "auth.provider == 'custom'" },
  }),
  cases: [
    { description: 'a true boolean claim is allowed', expectation: 'ALLOW', operation: 'write', opPath: '/admin', authPresent: true, claims: { admin: true }, newData: 'ok' },
    { description: 'a false boolean claim is denied', expectation: 'DENY', operation: 'write', opPath: '/admin', authPresent: true, claims: { admin: false }, newData: 'ok' },
    { description: 'a string claim with the expected value is allowed', expectation: 'ALLOW', operation: 'write', opPath: '/role', authPresent: true, claims: { role: 'editor' }, newData: 'ok' },
    { description: 'a string claim with another value is denied', expectation: 'DENY', operation: 'write', opPath: '/role', authPresent: true, claims: { role: 'viewer' }, newData: 'ok' },
    { description: 'a number claim over the bound is allowed', expectation: 'ALLOW', operation: 'write', opPath: '/level', authPresent: true, claims: { level: 5 }, newData: 'ok' },
    { description: 'a number claim under the bound is denied', expectation: 'DENY', operation: 'write', opPath: '/level', authPresent: true, claims: { level: 1 }, newData: 'ok' },
    { description: 'a nested object claim reads by dotted path', expectation: 'ALLOW', operation: 'write', opPath: '/nested', authPresent: true, claims: { org: { tier: 'gold' } }, newData: 'ok' },
    { description: 'a claim the token does not carry reads null', expectation: 'ALLOW', operation: 'write', opPath: '/absent', authPresent: true, claims: { role: 'editor' }, newData: 'ok' },
    { description: 'a custom-token sign-in reads sign_in_provider as custom', expectation: 'ALLOW', operation: 'write', opPath: '/provider', authPresent: true, claims: {}, newData: 'ok' },
    { description: 'a custom-token sign-in reads auth.provider as custom', expectation: 'ALLOW', operation: 'write', opPath: '/authprovider', authPresent: true, claims: {}, newData: 'ok' },
    { description: 'an anonymous user carries no admin claim', expectation: 'DENY', operation: 'write', opPath: '/admin', authPresent: true, newData: 'ok' },
    { description: 'signed out, a claim gate is denied', expectation: 'DENY', operation: 'write', opPath: '/admin', authPresent: false, newData: 'ok' },
  ],
};
