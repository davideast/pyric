import { row } from './section.ts';

export default row({
  order: 480,
  featureKeys: ["request.auth.token"],
  behavior: "A signed-in request always carries a `request.auth.token` map, even when the case names only a uid (ST-H1-7)",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "`oracle:rules-storage-h1-auth-token-default` (captured 2026-10-27, 4 cases) records production ALLOWING `token is a map`, `token is empty` and `token.get default` when the case gives no token. `buildRequestObject` defaults `request.auth.token` to `{}` when `request.auth` is present without an explicit token, agreeing on all 4 cases.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["the evaluator denies requests production allows"],
  oracleObservations: ["rules-storage-h1-auth-token-default"],
  conformanceTests: ["packages/rules/test/storage/rules-oracle-conformance.test.ts"],
  constructs: ["storage.binding.request.auth.token"],
});
