import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "Returns `UserCredential` with `providerId: null`, `operationType: 'signIn'`, and a `User` with `isAnonymous: true`, `email: null`, `displayName: null`",
  status: "conforms",
  evidence: "`unit:sandbox-anonymous.test.ts`, `playground:auth-anonymous` (bundled) + `playground:auth-row-6-anon-credential-shape` (one-claim) + oracle: `packages/conformance/observations/auth/auth-anonymous-credential-providerid.json` (`providerId: null` against digame-mas, fb-js-sdk 12.19.0). Prior matrix language said `providerId: 'anonymous'`; corrected after empirical observation. Sandbox aligned to prod in the same commit.",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  automation: "oracle-backed",
  oracleObservations: ["auth-anonymous-credential-providerid"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-anonymous.test.ts"],
  exceptionReason: "playground / preview behavior — no firebase-js-sdk counterpart to observe",
});
