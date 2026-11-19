import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "Fires on user change (sandbox shares the auth-state path)",
  evidence: "`unit:sandbox-listeners.test.ts` + oracle: `packages/conformance/observations/auth/auth-row-38-onidtokenchanged-fires-on-user-change.json` (against digame-mas, fb-js-sdk 12.19.0: subscribe → 1 initial fire (null) → `signInAnonymously` → +1 (user₁) → `signOut` → +1 (null) → `signInAnonymously` → +1 (user₂ with fresh uid). Every identity transition produces exactly one fire, matching `onAuthStateChanged`)",
  risk: ["listener-fire-count","listener"],
  riskScore: 4,
  riskReasons: ["asserts a specific listener fire count","asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["auth-row-38-onidtokenchanged-fires-on-user-change"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-listeners.test.ts"],
});
