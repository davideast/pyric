import { row } from './section.ts';

export default row({
  order: 90,
  behavior: "A throwing observer doesn't block other observers from firing",
  evidence: "`unit:sandbox-listeners.test.ts` + oracle: `packages/conformance/observations/auth/auth-row-35-throwing-observer-doesnt-block-others.json` (`secondObserverContinuedFiring: true` against digame-mas, fb-js-sdk 12.19.0 — observer #1 throws on every call, observer #2 still counts the initial fire AND the post-sign-in fire)",
  risk: ["specific-field","listener"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["auth-row-35-throwing-observer-doesnt-block-others"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-listeners.test.ts"],
});
