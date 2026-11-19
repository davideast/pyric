import { row } from './section.ts';

export default row({
  order: 60,
  behavior: "Fires `onAuthStateChanged` with the new user once",
  status: "conforms",
  evidence: "`unit:sandbox-listeners.test.ts` + oracle: `packages/conformance/observations/auth/auth-row-17-signin-email-password-fires-once.json` (against digame-mas, fb-js-sdk 12.19.0: createUser → signOut → subscribe (1 initial null fire) → `signInWithEmailAndPassword` → `firesForSignIn: 1` with the signed-in uid, `lastFireUidMatches: true`)",
  risk: ["specific-field","listener"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["auth-row-17-signin-email-password-fires-once"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-listeners.test.ts"],
});
