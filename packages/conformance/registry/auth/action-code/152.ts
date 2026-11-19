import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["applyActionCode"],
  api: "applyActionCode(auth, code)",
  behavior: "Redeems an out-of-band code and performs its state change (`VERIFY_EMAIL` sets `emailVerified`, `VERIFY_AND_CHANGE_EMAIL` moves the account to the new address). Throws `auth/invalid-action-code` for a code the project never issued, for the empty string, and for a code already redeemed (single-use). A `PASSWORD_RESET` code is refused — `confirmPasswordReset` owns that one.",
  status: "conforms",
  evidence: "ORACLE-BACKED on the reject path: `auth-action-code-invalid`, in the #1676 re-capture (firebase 12.19.0, digame-mas, Email/Password and Email Enumeration Protection on), confirmed prod emits `auth/invalid-action-code` for both a bogus code and the empty string. The APPLY path (a real code, redeemed) cannot be probed from a client — it needs a code from a real inbox — and is unit-backed end to end against the sandbox outbox in `unit:sandbox-email-link.test.ts`.",
  risk: ["error-code"],
  riskScore: 4,
  riskReasons: ["asserts Firebase error code(s): `auth/invalid-action-code`"],
  automation: "oracle-backed",
  oracleObservations: ["auth-action-code-invalid"],
  conformanceTests: ["packages/pyric/test/auth/oracle-conformance.test.ts","packages/pyric/test/auth/sandbox-email-link.test.ts"],
});
