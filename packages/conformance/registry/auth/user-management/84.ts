import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["updateEmail"],
  api: "updateEmail(user, newEmail)",
  behavior: "Changes the stored email (via the same path as `sandbox.updateUser`, rejecting `auth/email-already-in-use` / `auth/invalid-email`) and mutates the held `user` in place, so the next sign-in resolves against the new email. A session older than five minutes is refused with `auth/requires-recent-login`. Leniency vs prod: the sandbox is not routed through `verifyBeforeUpdateEmail`; with email-enumeration protection on, production refuses `updateEmail` with `auth/operation-not-allowed` (`Please verify the new email before changing email.`)",
  status: "diverged-documented",
  statusNote: "email really changes and the recent-login gate applies; email-enumeration protection is not modeled",
  evidence: "`unit:fruit-aliases.test.ts`: stored email changes; re-sign-in works with the new email, fails with the old. Recent-login gate: `unit:requires-recent-login.test.ts`. Oracle capture `auth-requires-recent-login` recorded `auth/operation-not-allowed` for updateEmail on the oracle project, which has email-enumeration protection on.",
  oracleObservations: ["auth-requires-recent-login"],
  conformanceTests: ["packages/pyric/test/auth/fruit-aliases.test.ts","packages/pyric/test/auth/requires-recent-login.test.ts"],
});
