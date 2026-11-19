import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "Initial-fire semantics match `onAuthStateChanged`",
  evidence: "`unit:sandbox-listeners.test.ts` + oracle: `packages/conformance/observations/auth/auth-row-40-onidtokenchanged-matches-onauthstatechanged-initial-fire.json` (against digame-mas, fb-js-sdk 12.19.0: subscribing both listeners in the same tick yields `sync: {auth: 0, idToken: 0}` → `microtask: {auth: 1, idToken: 1}` → no further fires. Both listeners share the microtask-deferred initial-fire timing)",
  risk: ["listener","timing"],
  riskScore: 4,
  riskReasons: ["asserts listener semantics","asserts timing semantics"],
  automation: "oracle-backed",
  oracleObservations: ["auth-row-40-onidtokenchanged-matches-onauthstatechanged-initial-fire"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-listeners.test.ts"],
});
