import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "Fires immediately on subscribe with the current value (microtask-deferred)",
  evidence: "`unit:sandbox-listeners.test.ts` + oracle: `packages/conformance/observations/auth/auth-row-29-onauthstatechanged-initial-fire-timing.json` (`firedSynchronously: 0, firedAfterMicrotask: 1` against digame-mas, fb-js-sdk 12.19.0 — initial fire does NOT arrive in the synchronous tick of `onAuthStateChanged(...)`; it lands after the first microtask flush)",
  risk: ["listener","timing"],
  riskScore: 4,
  riskReasons: ["asserts listener semantics","asserts timing semantics"],
  automation: "oracle-backed",
  oracleObservations: ["auth-row-29-onauthstatechanged-initial-fire-timing"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-listeners.test.ts"],
});
