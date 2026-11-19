import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["User"],
  api: "User` methods",
  behavior: "`user.uid`, `user.email`, `user.displayName`, `user.isAnonymous` reflect the source",
  status: "conforms",
  evidence: "`oracle:auth-user-identity-fields-by-source` (fb-js-sdk 12.19.0: anonymous vs email/password identity fields); `unit:auth-user-methods.test.ts` (in-page + served worker)",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  automation: "oracle-backed",
  oracleObservations: ["auth-user-identity-fields-by-source"],
  conformanceTests: ["packages/pyric/test/auth/oracle-captures/auth-user-methods.test.ts", "packages/cli/test/serve/worker/oracle-captures/auth-user-methods.test.ts"],
});
