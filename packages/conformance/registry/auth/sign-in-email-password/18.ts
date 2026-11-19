import { row } from './section.ts';

export default row({
  order: 70,
  behavior: "Email validation (RFC 5322ish) — rejects empty, missing `@`, missing local-part, missing domain with `auth/invalid-email`. Runs on both `signInWithEmailAndPassword` and `createUserWithEmailAndPassword` before any user-DB lookup, so consumers shipping malformed input see the same error sandbox vs prod.",
  status: "conforms",
  evidence: "`unit:sandbox-email-password.test.ts` + oracle: `packages/conformance/observations/auth/auth-row-18-invalid-email-error-code.json` (`code: 'auth/invalid-email'`, message `Firebase: Error (auth/invalid-email).` against digame-mas, fb-js-sdk 12.19.0)",
  risk: ["specific-value","error-code"],
  riskScore: 5,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `auth/invalid-email`"],
  automation: "oracle-backed",
  oracleObservations: ["auth-row-18-invalid-email-error-code"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-email-password.test.ts"],
});
