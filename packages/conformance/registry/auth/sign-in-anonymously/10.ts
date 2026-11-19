import { row } from './section.ts';

export default row({
  order: 50,
  behavior: "Fires `onAuthStateChanged` exactly once per state transition (no same-value double-fire)",
  status: "conforms",
  evidence: "`unit:sandbox-listeners.test.ts`, `playground:auth-anonymous` (bundled) + `playground:auth-row-10-onauthstatechanged-one-per-transition` (one-claim) — fix from #399 + oracle: `packages/conformance/observations/auth/auth-row-10-onauthstatechanged-one-per-transition.json` (against digame-mas, fb-js-sdk 12.19.0: subscribe → 1 initial null fire → `signInAnonymously` → +1 → `signOut` → +1 → `signInAnonymously` → +1. `eachTransitionFiredExactlyOnce: true` — every transition produces exactly one fire)",
  risk: ["listener-fire-count","specific-field","listener"],
  riskScore: 5,
  riskReasons: ["asserts a specific listener fire count","asserts a specific field/property value","asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["auth-row-10-onauthstatechanged-one-per-transition"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-listeners.test.ts"],
  exceptionReason: "playground / preview behavior — no firebase-js-sdk counterpart to observe",
});
