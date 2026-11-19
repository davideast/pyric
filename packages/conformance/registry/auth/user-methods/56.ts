import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["User"],
  api: "User` methods",
  behavior: "`user.getIdTokenResult()` returns claims",
  status: "conforms",
  evidence: "`oracle:auth-user-getidtokenresult-claims-shape` (fb-js-sdk 12.19.0: `token`, `claims`, `authTime`, `issuedAtTime`, `expirationTime`, `signInProvider`, and `signInSecondFactor: null`); `unit:auth-user-methods.test.ts` (in-page + served worker)",
  automation: "oracle-backed",
  oracleObservations: ["auth-user-getidtokenresult-claims-shape"],
  conformanceTests: ["packages/pyric/test/auth/oracle-captures/auth-user-methods.test.ts", "packages/cli/test/serve/worker/oracle-captures/auth-user-methods.test.ts", "packages/pyric/test/auth/sandbox-providers.test.ts"],
});
