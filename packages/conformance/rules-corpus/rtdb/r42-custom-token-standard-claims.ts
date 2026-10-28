/**
 * ─── r42-custom-token-standard-claims ─────────────────────────────────────
 * Standard ID-token fields (`sub`, `iat`, `exp`, `iss`, `aud`, `auth_time`,
 * `user_id`, `firebase.identities`, `firebase.sign_in_provider`) on
 * `auth.token` when signed in with a custom token (`claims: { role: 'member' }`).
 *
 * Production mints a full Firebase ID token on `signInWithCustomToken`, so
 * standard JWT and Firebase metadata claims are populated alongside the
 * developer's custom claims. In `rules-rtdb-replay.ts` (`authFor`), custom-token
 * cases (`claims !== undefined`) previously constructed `token` with only
 * `firebase: { sign_in_provider: 'custom' }` and the custom claims, omitting
 * `sub`, `iat`, `exp`, `iss`, `aud`, `auth_time`, `user_id`, and
 * `firebase.identities`.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'rules reading standard ID-token fields on auth.token (sub, iat, exp, iss, aud, auth_time, user_id, firebase.identities, firebase.sign_in_provider) must see the same non-null values in the simulator and sandbox that production exposes.',
  provenance:
    'Authored from 2026-10-15 bug hunt (COV-3) to pin standard ID-token fields on auth.token after custom-token sign-in against production. Captured by deploy-observe-restore on 2026-10-15 in observations/rtdb-rules/rules-rtdb-r42-custom-token-standard-claims.json.',
  rules: JSON.stringify({
    subNonNull: { '.read': 'auth.token.sub != null' },
    subMatchesUid: { '.read': 'auth.token.sub == auth.uid' },
    iatNonNull: { '.read': 'auth.token.iat != null' },
    expNonNull: { '.read': 'auth.token.exp != null' },
    issNonNull: { '.read': 'auth.token.iss != null' },
    audNonNull: { '.read': 'auth.token.aud != null' },
    authTimeNonNull: { '.read': 'auth.token.auth_time != null' },
    userIdNonNull: { '.read': 'auth.token.user_id != null' },
    userIdMatchesUid: { '.read': 'auth.token.user_id == auth.uid' },
    identitiesNonNull: { '.read': 'auth.token.firebase.identities != null' },
    providerNonNull: { '.read': 'auth.token.firebase.sign_in_provider != null' },
    providerIsCustom: { '.read': "auth.token.firebase.sign_in_provider == 'custom'" },
  }),
  cases: [
    {
      description: 'COV-3: custom-token auth.token.sub != null',
      expectation: 'ALLOW',
      operation: 'read',
      opPath: '/subNonNull',
      authPresent: true,
      claims: { role: 'member' },
    },
    {
      description: 'COV-3: custom-token auth.token.sub == auth.uid',
      expectation: 'ALLOW',
      operation: 'read',
      opPath: '/subMatchesUid',
      authPresent: true,
      claims: { role: 'member' },
    },
    {
      description: 'COV-3: custom-token auth.token.iat != null',
      expectation: 'ALLOW',
      operation: 'read',
      opPath: '/iatNonNull',
      authPresent: true,
      claims: { role: 'member' },
    },
    {
      description: 'COV-3: custom-token auth.token.exp != null',
      expectation: 'ALLOW',
      operation: 'read',
      opPath: '/expNonNull',
      authPresent: true,
      claims: { role: 'member' },
    },
    {
      description: 'COV-3: custom-token auth.token.iss != null',
      expectation: 'ALLOW',
      operation: 'read',
      opPath: '/issNonNull',
      authPresent: true,
      claims: { role: 'member' },
    },
    {
      description: 'COV-3: custom-token auth.token.aud != null',
      expectation: 'ALLOW',
      operation: 'read',
      opPath: '/audNonNull',
      authPresent: true,
      claims: { role: 'member' },
    },
    {
      description: 'COV-3: custom-token auth.token.auth_time != null',
      expectation: 'ALLOW',
      operation: 'read',
      opPath: '/authTimeNonNull',
      authPresent: true,
      claims: { role: 'member' },
    },
    {
      description: 'COV-3: custom-token auth.token.user_id != null',
      expectation: 'ALLOW',
      operation: 'read',
      opPath: '/userIdNonNull',
      authPresent: true,
      claims: { role: 'member' },
    },
    {
      description: 'COV-3: custom-token auth.token.user_id == auth.uid',
      expectation: 'ALLOW',
      operation: 'read',
      opPath: '/userIdMatchesUid',
      authPresent: true,
      claims: { role: 'member' },
    },
    {
      description: 'COV-3: custom-token auth.token.firebase.identities != null',
      expectation: 'ALLOW',
      operation: 'read',
      opPath: '/identitiesNonNull',
      authPresent: true,
      claims: { role: 'member' },
    },
    {
      description: 'COV-3: custom-token auth.token.firebase.sign_in_provider != null',
      expectation: 'ALLOW',
      operation: 'read',
      opPath: '/providerNonNull',
      authPresent: true,
      claims: { role: 'member' },
    },
    {
      description: 'COV-3: custom-token auth.token.firebase.sign_in_provider == "custom"',
      expectation: 'ALLOW',
      operation: 'read',
      opPath: '/providerIsCustom',
      authPresent: true,
      claims: { role: 'member' },
    },
  ],
};
