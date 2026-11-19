import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "Fires `onAuthStateChanged` with `null` exactly once",
  status: "conforms",
  evidence: "`unit:sandbox-listeners.test.ts`, `playground:auth-anonymous` (bundled) + `playground:auth-row-26-signout-fires-null-once` (one-claim) + oracle: `packages/conformance/observations/auth/auth-row-26-signout-fires-null-once.json` (against digame-mas, fb-js-sdk 12.19.0: subscribe (1 initial null fire) → `signInAnonymously` → `signOut` → `firesForSignOut: 1` with `lastFireUidWasNull: true`)",
  risk: ["specific-field","listener"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["auth-row-26-signout-fires-null-once"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-listeners.test.ts"],
  exceptionReason: "playground / preview behavior — no firebase-js-sdk counterpart to observe",
});
