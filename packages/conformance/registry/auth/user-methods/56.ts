import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["User"],
  api: "User` methods",
  behavior: "`user.getIdTokenResult()` returns claims, UTC date strings (`authTime`, `issuedAtTime`, `expirationTime`), `signInProvider`, and `signInSecondFactor`",
  status: "conforms",
  evidence: "`oracle:auth-user-getidtokenresult-claims-shape` + `oracle:auth-request-auth-per-sign-in` (fb-js-sdk 12.19.0: `token`, `claims`, UTC-string `authTime`/`issuedAtTime`/`expirationTime`, `signInProvider`, and `signInSecondFactor: null`); `unit:auth-user-methods.test.ts` (in-page + served worker), `unit:id-token-result-format.test.ts`",
  automation: "oracle-backed",
  oracleObservations: ["auth-user-getidtokenresult-claims-shape"],
  conformanceTests: ["packages/pyric/test/auth/oracle-captures/auth-user-methods.test.ts", "packages/cli/test/serve/worker/oracle-captures/auth-user-methods.test.ts", "packages/pyric/test/auth/id-token-result-format.test.ts", "packages/pyric/test/auth/sandbox-providers.test.ts"],
});
