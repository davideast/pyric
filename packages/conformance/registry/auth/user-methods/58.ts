import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["User"],
  api: "User` methods",
  behavior: "`user.emailVerified` — present on every sandbox-minted `User` (default `false`; sandbox has no verification flow). Prod passes the real value through (no longer stripped). The admin record (`sandbox.listUsers`) carries it too",
  status: "conforms",
  evidence: "`oracle:auth-user-email-verified-passthrough` (fb-js-sdk 12.19.0: anonymous/unverified `false`, Admin-verified `true`, matching Admin `UserRecord.emailVerified`); `unit:auth-user-methods.test.ts` (in-page + served worker)",
  automation: "oracle-backed",
  oracleObservations: ["auth-user-email-verified-passthrough"],
  conformanceTests: ["packages/pyric/test/auth/oracle-captures/auth-user-methods.test.ts", "packages/cli/test/serve/worker/oracle-captures/auth-user-methods.test.ts", "packages/pyric/test/auth/auth-gap-surface.test.ts"],
});
