import { row } from './section.ts';

export default row({
  order: 50,
  behavior: "Fires `onAuthStateChanged` with the new user once",
  evidence: "`unit:sandbox-listeners.test.ts` + oracle: `packages/conformance/observations/auth/auth-row-24-createuser-fires-once.json` (against digame-mas, fb-js-sdk 12.19.0: subscribe (1 initial null fire) → `createUserWithEmailAndPassword` → `firesForCreate: 1` with the newly-created uid, `lastFireUidMatches: true`)",
  risk: ["specific-field","listener"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["auth-row-24-createuser-fires-once"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-listeners.test.ts"],
});
