import { row } from './section.ts';

export default row({
  order: 130,
  featureKeys: ["User"],
  api: "User` methods",
  behavior: "Custom-claims changes (`sandbox.updateUser` / re-seed) reach an active session on the next FORCED token refresh, not immediately — claims are read live from the user DB at mint time (prod's refresh-propagation story; AUTH-B10)",
  status: "conforms",
  evidence: "`unit:sandbox-user-admin.test.ts`, `unit:sandbox-cluster-b9-b12.test.ts`",
  risk: ["timing"],
  riskScore: 2,
  riskReasons: ["asserts timing semantics"],
  automation: "oracle-backed",
  oracleObservations: ["auth-claims-forced-refresh-propagation"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-cluster-b9-b12.test.ts","packages/pyric/test/auth/sandbox-user-admin.test.ts"],
});
