import { row } from './section.ts';

export default row({
  order: 330,
  featureKeys: ["auth.token"],
  behavior: "Custom-token sign-in populates standard ID-token fields on `auth.token` (`sub`, `iat`, `exp`, `iss`, `aud`, `auth_time`, `user_id`, `firebase.identities`, `firebase.sign_in_provider`) as production does (COV-3)",
  status: "conforms",
  evidence: "`oracle:rules-rtdb-r42-custom-token-standard-claims` (captured 2026-10-15) records 12 production verdicts after custom-token sign-in (`claims: { role: 'member' }`): production ALLOWS all 12 checks (`sub != null`, `sub == auth.uid`, `iat != null`, `exp != null`, `iss != null`, `aud != null`, `auth_time != null`, `user_id != null`, `user_id == auth.uid`, `firebase.identities != null`, `firebase.sign_in_provider != null`, and `firebase.sign_in_provider == 'custom'`). A signed-in sandbox session's `auth.token` is the minted ID token's full claim set (`rulesTokenFromIdToken` in `rules/auth/token-claims.ts`, #1341), so `sub`, `iat`, `auth_time`, `exp`, `iss` and `aud` carry the minted values and `auth_time` stays at the sign-in. `iss` is `https://securetoken.google.com/<projectId>` and `aud` the project id, as production's are (#1503); a caller that knows no project mints for `pyric-sandbox`. For a `simulate()` case that omits them, `withIdTokenClaims` fills the standard ID-token fields (`sub`, `user_id`, `iat`, `auth_time`, `exp`, `iss`, `aud`, `firebase.identities`). Both match all 12 verdicts.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts standard auth.token claims are populated on custom-token sign-in (COV-3)"],
  oracleObservations: ["rules-rtdb-r42-custom-token-standard-claims"],
  conformanceTests: ["packages/rules/test/rtdb/rules-conformance.test.ts", "packages/pyric/test/rules/rtdb/simulation/handler.test.ts", "packages/pyric/test/auth/rules-token-claims.test.ts"],
  constructs: ["rtdb.binding.auth.token", "rtdb.binding.auth.token.custom-claim"],
});
