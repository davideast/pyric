import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["sendSignInLinkToEmail"],
  api: "sendSignInLinkToEmail(auth, email, settings)",
  behavior: "ActionCodeSettings validation, enforced CLIENT-side before any request leaves the process: a missing or unparseable `url` throws `auth/invalid-continue-uri` (NOT `auth/missing-continue-uri`, despite the constant's name), and `handleCodeInApp` other than `true` throws `auth/argument-error`. On success the sandbox mints a single-use code and posts the message to the outbox.",
  status: "conforms",
  evidence: "ORACLE-BACKED on both client-side arms (project-independent — prod threw before any network call): `auth-sendsigninlinktoemail-settings-validation` captured `missingUrl: auth/invalid-continue-uri` and `handleCodeInAppFalse: auth/argument-error`, unchanged in the #1676 re-capture (firebase 12.19.0, digame-mas, Email/Password and Email Enumeration Protection on). The same capture recorded the server arms: `invalidUrl: auth/invalid-continue-uri` and `unauthorizedDomain: auth/unauthorized-continue-uri` (auth#163). Replayed in `unit:oracle-conformance.test.ts`; the send path is unit-backed in `unit:sandbox-email-link.test.ts`.",
  risk: ["error-code"],
  riskScore: 4,
  riskReasons: ["asserts Firebase error code(s): `auth/invalid-continue-uri`, `auth/argument-error`"],
  automation: "oracle-backed",
  oracleObservations: ["auth-sendsigninlinktoemail-settings-validation"],
  conformanceTests: ["packages/pyric/test/auth/oracle-conformance.test.ts","packages/pyric/test/auth/sandbox-email-link.test.ts"],
});
