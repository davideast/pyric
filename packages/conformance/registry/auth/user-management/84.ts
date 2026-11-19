import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["updateEmail"],
  api: "updateEmail(user, newEmail)",
  behavior: "Changes the stored email (via the same path as `sandbox.updateUser`, rejecting `auth/email-already-in-use` / `auth/invalid-email`) and mutates the held `user` in place, so the next sign-in resolves against the new email. A session older than five minutes is refused with `auth/requires-recent-login`. Leniency vs prod: the sandbox is not routed through `verifyBeforeUpdateEmail`; with email-enumeration protection on, production refuses `updateEmail` with `auth/operation-not-allowed` (`Please verify the new email before changing email.`)",
  status: "diverged-documented",
  statusNote: "email really changes and the recent-login gate applies; email-enumeration protection is not modeled",
  evidence: "`oracle:auth-requires-recent-login` (fb-js-sdk 12.19.0: recorded `auth/operation-not-allowed` for `updateEmail` under Email Enumeration Protection, pinned against Pyric's `auth/requires-recent-login` gate and live email mutation in `unit:auth-update-email-recent-login.test.ts` across in-page, SharedWorker, and Node-hosted WebSocket planes); `unit:fruit-aliases.test.ts`; `unit:requires-recent-login.test.ts`.",
  automation: "oracle-backed",
  oracleObservations: ["auth-requires-recent-login"],
  conformanceTests: [
    "packages/pyric/test/auth/oracle-captures/auth-update-email-recent-login.test.ts",
    "packages/cli/test/serve/worker/oracle-captures/auth-update-email-recent-login.test.ts",
    "packages/pyric/test/auth/fruit-aliases.test.ts",
    "packages/pyric/test/auth/requires-recent-login.test.ts",
  ],
});
