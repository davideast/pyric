import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["User"],
  api: "User` methods",
  behavior: "`getIdToken()` returns a three-segment base64url JWT (header `alg` RS256, `typ` JWT, a `kid`) whose payload decodes to `getIdTokenResult().claims`",
  status: "conforms",
  evidence: "`oracle:auth-user-getidtoken-jwt-structure` (fb-js-sdk 12.19.0: 3 base64url segments, `alg: 'RS256'`, `typ: 'JWT'`, non-empty `kid`, `exp - iat === 3600`, decoded payload equals `getIdTokenResult().claims`); `oracle:auth-id-token-standard-claims`; `unit:auth-user-methods.test.ts` (in-page + served worker)",
  automation: "oracle-backed",
  oracleObservations: ["auth-user-getidtoken-jwt-structure"],
  conformanceTests: ["packages/pyric/test/auth/oracle-captures/auth-user-methods.test.ts", "packages/cli/test/serve/worker/oracle-captures/auth-user-methods.test.ts", "packages/pyric/test/auth/sandbox-anonymous.test.ts", "packages/pyric-admin/src/auth/auth.test.ts", "packages/cli/test/serve/worker/auth-standard-claims.test.ts"],
});
