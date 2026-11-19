import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: ["sendEmailVerification"],
  api: "sendEmailVerification(user)",
  behavior: "Throws `auth/missing-email` for a user with no email on the account (an anonymous user). For a real account the mail goes out and NOTHING ELSE HAPPENS: `user.emailVerified` stays `false`. Verification happens when the code in the message is redeemed (`applyActionCode`), not when it is sent.",
  status: "conforms",
  evidence: "ORACLE-BACKED on the anonymous reject: `auth-sendemailverification-shape` captured `anonymousUserCode: auth/missing-email` against prod. The send-does-not-verify property is the one the whole flow turns on and is unit-backed (`unit:sandbox-email-link.test.ts` asserts `emailVerified` is still false after the send and true only after the code is applied) — it cannot be oracle-confirmed end to end because confirming it would require reading a real inbox.",
  risk: ["error-code"],
  riskScore: 4,
  riskReasons: ["asserts Firebase error code(s): `auth/missing-email`"],
  automation: "oracle-backed",
  oracleObservations: ["auth-sendemailverification-shape"],
  conformanceTests: ["packages/pyric/test/auth/oracle-conformance.test.ts","packages/pyric/test/auth/sandbox-email-link.test.ts"],
});
