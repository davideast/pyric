import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "Returns `UserCredential` with `providerId: null` (NOT `'password'` — only OAuth/phone responses carry a providerId; upstream `providerIdForResponse` returns null for email/password), `operationType: 'signIn'`, and a `User` with the stored uid + email",
  status: "conforms",
  evidence: "`unit:sandbox-email-password.test.ts` + oracle: `packages/conformance/observations/auth/auth-createUser-operationType.json` (`providerId: null` against digame-mas, fb-js-sdk 12.19.0). Prior matrix language said `providerId: 'password'`; corrected after the oracle contradicted it (AUTH-B2).",
  risk: ["specific-value","specific-field"],
  riskScore: 3,
  riskReasons: ["asserts 1 specific value(s)","asserts a specific field/property value"],
  automation: "oracle-backed",
  oracleObservations: ["auth-createUser-operationType"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-email-password.test.ts"],
});
