import { row } from './section.ts';

export default row({
  order: 100,
  featureKeys: ["User"],
  api: "User` methods",
  behavior: "`IdTokenResult.signInProvider` reflects the session's provider per flow (`'anonymous'` / `'password'` / `'google.com'` / …); claims include the reserved `firebase.sign_in_provider` (custom claims can't shadow it)",
  status: "conforms",
  evidence: "`unit:sandbox-user-admin.test.ts` (\"IdTokenResult.signInProvider\"), `oracle:auth-signinprovider-per-flow`",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts 3 specific value(s)"],
  automation: "oracle-backed",
  oracleObservations: ["auth-signinprovider-per-flow"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-user-admin.test.ts"],
});
