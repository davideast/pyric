import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "Fires on every subsequent identity change",
  evidence: "`unit:sandbox-listeners.test.ts`, `playground:auth-anonymous` + oracle: `packages/conformance/observations/auth/auth-row-30-onauthstatechanged-fires-on-every-transition.json` (against digame-mas, fb-js-sdk 12.19.0: subscribe → `signIn` → `signOut` → `signIn` → `signOut`, each of the 4 transitions produced exactly 1 fire; `eachTransitionFiredExactlyOnce: true`)",
  risk: ["listener-fire-count","specific-field","listener"],
  riskScore: 5,
  riskReasons: ["asserts a specific listener fire count","asserts a specific field/property value","asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["auth-row-30-onauthstatechanged-fires-on-every-transition"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-listeners.test.ts"],
  exceptionReason: "playground / preview behavior — no firebase-js-sdk counterpart to observe",
});
