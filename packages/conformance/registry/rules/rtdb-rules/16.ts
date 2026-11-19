import { row } from './section.ts';

export default row({
  order: 160,
  featureKeys: ["auth.provider"],
  behavior: "`auth.provider` names the sign-in method, equal to `auth.token.firebase.sign_in_provider` (`anonymous` for an anonymous sign-in), and `auth.tenant` reads null without a tenant",
  evidence: "`oracle:rules-rtdb-r16-auth-provider-and-tenant` records production for an anonymous sign-in: `auth.provider == 'anonymous'` ALLOWS, `auth.provider == 'password'` DENIES, `auth.provider == auth.token.firebase.sign_in_provider` ALLOWS, and both `auth.tenant == null` and `auth.token.firebase.tenant == null` ALLOW. The simulator matches all 7 cases: it builds `auth` through the shared `normalizeAuthState` and reads `provider` from the token's `sign_in_provider`. The sandbox's own enforcement agrees, because a signed-in data context's `auth.token` carries the `firebase` namespace of its minted ID token (`packages/pyric/test/auth/sandbox-backend-rules-token.test.ts`). The corpus signs in anonymously only, so a federated provider's `auth.provider` value is not captured.",
  risk: ["specific-value", "rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts 1 specific value(s)", "asserts rules-denial behavior"],
  oracleObservations: ["rules-rtdb-r16-auth-provider-and-tenant"],
  constructs: ["rtdb.binding.auth"],
});
