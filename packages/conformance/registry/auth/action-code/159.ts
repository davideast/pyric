import { row } from './section.ts';

export default row({
  order: 100,
  featureKeys: ["checkActionCode","verifyPasswordResetCode","confirmPasswordReset"],
  api: "checkActionCode(auth, code) / verifyPasswordResetCode(auth, code) / confirmPasswordReset(auth, code, newPassword)",
  behavior: "`checkActionCode` and `verifyPasswordResetCode` INSPECT a code without burning it — a check must not destroy the code the subsequent apply needs. `confirmPasswordReset` redeems it and sets the password, running the same strength check `createUserWithEmailAndPassword` runs; a weak new password throws `auth/weak-password` and does NOT burn the code (a typo must not destroy the user's one reset link). A code staged as expired throws `auth/expired-action-code`.",
  status: "conforms",
  evidence: "ORACLE-BACKED on the invalid-code reject: `auth-action-code-invalid`, in the #1676 re-capture (firebase 12.19.0, digame-mas, Email/Password and Email Enumeration Protection on), captured `auth/invalid-action-code` from `checkActionCode`, `verifyPasswordResetCode` and `confirmPasswordReset` for a code the project never issued. Replayed in `unit:oracle-conformance.test.ts`. The earlier capture answered `auth/operation-not-allowed` because that project had the password provider disabled. The inspect-without-burning, weak-password and expired-code behavior needs a real issued code and is unit-backed in `unit:sandbox-email-link.test.ts`.",
  automation: "oracle-backed",
  oracleObservations: ["auth-action-code-invalid"],
  conformanceTests: ["packages/pyric/test/auth/oracle-conformance.test.ts","packages/pyric/test/auth/sandbox-email-link.test.ts"],
});
