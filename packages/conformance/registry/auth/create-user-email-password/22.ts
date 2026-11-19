import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "Throws `auth/email-already-in-use` when the email is already registered",
  evidence: "`unit:sandbox-email-password.test.ts` + oracle: `packages/conformance/observations/auth/auth-email-already-in-use-error-code.json` (`code: 'auth/email-already-in-use'` against digame-mas, fb-js-sdk 12.19.0; matches sandbox)",
  risk: ["specific-value","error-code"],
  riskScore: 5,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `auth/email-already-in-use`"],
  automation: "oracle-backed",
  oracleObservations: ["auth-email-already-in-use-error-code"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-email-password.test.ts"],
});
