import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "**No duplicate fire** when subscribe is followed by a synchronous `setCurrentUser` — dedup ensures observer sees the new value once, not twice. Sandbox-only concern: prod has no synchronous state-change API, so the dedup window can't be exercised against the cloud SDK; subscribe-then-async-signIn naturally fires twice (initial + new value) because the microtask between them flushes the initial fire",
  evidence: "`unit:sandbox-listeners.test.ts` (regression test from #399), `playground:auth-anonymous` + oracle baseline: `packages/conformance/observations/auth/auth-row-31-onauthstatechanged-no-dup-on-sync-transition.json` (against digame-mas, fb-js-sdk 12.19.0: subscribe + async `signInAnonymously` in the same tick produces `totalFires: 2` — `{uid: null, ts: 0}` then `{uid: <user>, ts: ~400ms}`. Confirms prod cannot exhibit the same-tick race; the dedup behavior remains a sandbox-only property)",
  risk: ["listener-fire-count","specific-field","listener"],
  riskScore: 5,
  riskReasons: ["asserts a specific listener fire count","asserts a specific field/property value","asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["auth-row-31-onauthstatechanged-no-dup-on-sync-transition"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-listeners.test.ts"],
  exceptionReason: "sandbox-only behavior — no prod equivalent to observe",
});
