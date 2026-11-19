import { row } from './section.ts';

export default row({
  order: 100,
  behavior: "Observer object form (`{next, error, complete}`) works alongside the function form",
  evidence: "`unit:sandbox-listeners.test.ts` + oracle: `packages/conformance/observations/auth/auth-row-36-observer-object-form-works.json` (against digame-mas, fb-js-sdk 12.19.0: one observer as `NextFn`, another as `{next, error, complete}`. Both forms see 1 initial null fire, +1 on `signInAnonymously`, +1 on `signOut`; `bothFormsFiredOnSignIn: true, bothFormsFiredOnSignOut: true`)",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["auth-row-36-observer-object-form-works"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-listeners.test.ts"],
});
