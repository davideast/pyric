import { row } from './section.ts';

export default row({
  order: 60,
  behavior: "Multiple subscribers all fire on each change",
  evidence: "`unit:sandbox-listeners.test.ts` + oracle: `packages/conformance/observations/auth/auth-row-33-multiple-subscribers-all-fire.json` (against digame-mas, fb-js-sdk 12.19.0: two subscribers registered back-to-back each see 1 initial null fire, +1 on `signInAnonymously`, +1 on `signOut`; `bothFiredOnSignIn: true, bothFiredOnSignOut: true`)",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["auth-row-33-multiple-subscribers-all-fire"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-listeners.test.ts"],
});
