import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["User"],
  api: "User` methods",
  behavior: "`user.getIdToken(true)` (forceRefresh) returns a NEW token; subsequent `getIdToken(false)` returns the cached new token",
  status: "conforms",
  evidence: "`unit:sandbox-token-refresh.test.ts` — was ⚠ (documented divergence); aligned to prod in commit — sandbox now mints a fresh token on forceRefresh and fires `onIdTokenChanged`. Oracle: `packages/conformance/observations/auth/auth-getidtoken-force-refresh.json` defines the target shape (`forceRefreshReturnedDifferentString: true`, `token1EqualsToken2: true` against digame-mas — the refreshed token is cached, so a subsequent non-forced read returns it, not yet another fresh one). Sandbox tokens are JWTs, as production's are (row 54); the header's `pyric_mint` numbers each mint, so two refreshes in the same second still return two strings.",
  risk: ["specific-value","specific-field","listener"],
  riskScore: 5,
  riskReasons: ["asserts 1 specific value(s)","asserts a specific field/property value","asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["auth-getidtoken-force-refresh"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-token-refresh.test.ts"],
});
