import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "Returns `UserCredential` with `operationType: 'signIn'` (NOT `'register'` — matches prod)",
  evidence: "`unit:sandbox-email-password.test.ts` + oracle: `packages/conformance/observations/auth/auth-createUser-operationType.json` (`operationType: 'signIn'` against digame-mas, fb-js-sdk 12.19.0; matches sandbox)",
  risk: ["specific-value","specific-field"],
  riskScore: 3,
  riskReasons: ["asserts 1 specific value(s)","asserts a specific field/property value"],
  automation: "oracle-backed",
  oracleObservations: ["auth-createUser-operationType"],
  conformanceTests: ["packages/pyric/test/auth/oracle-conformance.test.ts","packages/pyric/test/auth/sandbox-email-password.test.ts"],
  conformanceChecks: [{"finding":"AUTH-B2","observation":"auth-createUser-operationType","expect":{"providerId":null,"operationType":"signIn"},"probe":"packages/pyric/test/auth/oracle-conformance.test.ts","guards":"createUserWithEmailAndPassword returns providerId: null + operationType: 'signIn' (not 'password')."}],
});
