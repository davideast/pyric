/**
 * ─── r16-auth-provider-and-tenant ─────────────────────────────────────────
 * What the `auth` variable carries besides `uid` and `token` for a signed-in
 * user: whether `auth.provider` exists and what it reads for an anonymous
 * sign-in, and whether `auth.tenant` is a property at all. The corpus ops run
 * as an anonymous user or signed out, so this pins the anonymous provider name
 * only; a federated provider's name stays unverified.
 *
 * Covers: auth.provider and auth.tenant on the RTDB auth variable.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'the RTDB simulator must expose the same auth properties production does, with the same values, so a provider or tenant gate evaluates the same locally and in production.',
  provenance:
    'Authored to settle what `auth.provider` and `auth.tenant` read in RTDB rules. Expectations are the production allow/deny verdicts recorded by the deploy-observe-restore capture in observations/rtdb-rules/rules-rtdb-r16-auth-provider-and-tenant.json.',
  rules: JSON.stringify({
    '.read': 'auth != null',
    anonymous: { '.write': "auth.provider == 'anonymous'" },
    password: { '.write': "auth.provider == 'password'" },
    hasprovider: { '.write': 'auth.provider != null' },
    tokenprovider: { '.write': 'auth.provider == auth.token.firebase.sign_in_provider' },
    authtenant: { '.write': 'auth.tenant == null' },
    tokentenant: { '.write': 'auth.token.firebase.tenant == null' },
  }),
  cases: [
    { description: 'anonymous sign-in reads auth.provider as anonymous', expectation: 'ALLOW', operation: 'write', opPath: '/anonymous', authPresent: true, newData: 'ok' },
    { description: 'anonymous sign-in does not read auth.provider as password', expectation: 'DENY', operation: 'write', opPath: '/password', authPresent: true, newData: 'ok' },
    { description: 'auth.provider is present for a signed-in user', expectation: 'ALLOW', operation: 'write', opPath: '/hasprovider', authPresent: true, newData: 'ok' },
    { description: 'auth.provider equals the token sign_in_provider claim', expectation: 'ALLOW', operation: 'write', opPath: '/tokenprovider', authPresent: true, newData: 'ok' },
    { description: 'auth.tenant reads null without a tenant', expectation: 'ALLOW', operation: 'write', opPath: '/authtenant', authPresent: true, newData: 'ok' },
    { description: 'the token tenant claim reads null without a tenant', expectation: 'ALLOW', operation: 'write', opPath: '/tokentenant', authPresent: true, newData: 'ok' },
    { description: 'signed out, auth.provider cannot be read', expectation: 'DENY', operation: 'write', opPath: '/hasprovider', authPresent: false, newData: 'ok' },
  ],
};
