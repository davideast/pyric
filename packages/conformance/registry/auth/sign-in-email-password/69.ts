import { row } from './section.ts';

export default row({
  order: 90,
  status: "conforms",
  automation: "oracle-backed",
  behavior: "Disabled accounts (`sandbox.updateUser(..., {disabled: true})`) reject sign-in with `auth/user-disabled` (including when a wrong password is supplied or via custom token) and leave a held session signed in until its next forced token refresh, which rejects with `auth/user-disabled` and signs the user out (`@firebase/auth` `_logoutIfInvalidated`), on both in-page and worker planes; a deleted account's refresh, or one authenticated before a password change, rejects `auth/user-token-expired` (#1950). Revocations and deletions hold across reload (#2018) and checkpoint restore/fork/promote (#2021)",
  evidence: "`unit:sandbox-user-admin.test.ts`, `unit:auth.test.ts`, `test/apps/id-token-bearer-header`, `test/apps/inpage-auth-revocation-reload`, oracle: `auth-disabled-account-signin-and-refresh.json`",
  risk: ["specific-value","error-code"],
  riskScore: 5,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `auth/user-disabled`"],
  oracleObservations: ["auth-disabled-account-signin-and-refresh"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-user-admin.test.ts","packages/cli/test/serve/worker/auth.test.ts","packages/pyric/test/auth/oracle-captures/auth-handles-persistence-disabled.test.ts","packages/cli/test/serve/worker/oracle-captures/auth-handles-persistence-disabled.test.ts"],
});
