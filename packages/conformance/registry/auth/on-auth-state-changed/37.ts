import { row } from './section.ts';

export default row({
  order: 110,
  behavior: "Setting the same user twice does NOT double-fire (structural-equality no-op). Sandbox-internal `setCurrentUser` claim; the prod analog is `signInAnonymously` called twice in a row (per fix #399, the second call returns the same user).",
  evidence: "`unit:sandbox-listeners.test.ts` + oracle: `packages/conformance/observations/auth/auth-row-37-same-user-no-double-fire.json` (against digame-mas, fb-js-sdk 12.19.0: first `signInAnonymously` fires the listener once; second call returns the same uid (`sameUserAcrossCalls: true`) and does NOT produce a fresh fire (`secondSignInProducedFire: false`). Prod also recognizes the same-user no-op)",
  risk: ["specific-field","listener"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["auth-row-37-same-user-no-double-fire"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-listeners.test.ts"],
});
