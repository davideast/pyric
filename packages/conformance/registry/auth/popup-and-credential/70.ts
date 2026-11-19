import { row } from './section.ts';

export default row({
  order: 80,
  behavior: "Provider-flow sign-ins (popup / redirect / credential) record the flow's `providerId` on the identity in the user DB (upsert for unknown uids; append-if-missing for known ones) and reject disabled accounts with `auth/user-disabled` before any state change",
  status: "conforms",
  evidence: "`unit:sandbox-user-admin.test.ts` (\"provider tracking\", \"disabled users\") — provider recording is sandbox bookkeeping for `listIdentities`/`listUsers`; prod's auto-link semantics are narrower (same-email Google auto-link only) and not modeled",
  risk: ["specific-value","error-code"],
  riskScore: 5,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `auth/user-disabled`"],
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/auth/sandbox-user-admin.test.ts"],
});
