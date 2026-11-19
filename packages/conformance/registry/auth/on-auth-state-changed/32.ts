import { row } from './section.ts';

export default row({
  order: 50,
  behavior: "Returned `Unsubscribe` removes the observer; subsequent state changes do NOT fire it",
  evidence: "`unit:sandbox-listeners.test.ts`, `playground:auth-listener-unsub` (bundled) + `playground:auth-row-32-unsubscribe-stops-fires` (one-claim) + oracle: `packages/conformance/observations/auth/auth-row-32-unsubscribe-stops-fires.json` (against digame-mas, fb-js-sdk 12.19.0: subscribe → 1 fire on `signInAnonymously` → call `unsub()` → `signOut` + `signInAnonymously` + `signOut` produce zero further fires; `postUnsubFires: 0, unsubscribeStoppedFires: true`)",
  risk: ["specific-field","listener"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["auth-row-32-unsubscribe-stops-fires"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-listeners.test.ts"],
  exceptionReason: "playground / preview behavior — no firebase-js-sdk counterpart to observe",
});
