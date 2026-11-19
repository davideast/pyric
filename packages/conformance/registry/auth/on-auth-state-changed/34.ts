import { row } from './section.ts';

export default row({
  order: 80,
  behavior: "Unsubscribing during emission does not skip remaining subscribers (snapshotted iteration)",
  evidence: "`oracle:auth-onauthstatechanged-duplicate-fn-and-unsub-during-emit` (fb-js-sdk 12.19.0); `unit:auth-listeners-and-middleware.test.ts` (in-page + served worker); `unit:sandbox-listeners.test.ts`",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["auth-onauthstatechanged-duplicate-fn-and-unsub-during-emit"],
  conformanceTests: ["packages/pyric/test/auth/oracle-captures/auth-listeners-and-middleware.test.ts","packages/cli/test/serve/worker/oracle-captures/auth-listeners-and-middleware.test.ts","packages/pyric/test/auth/sandbox-listeners.test.ts"],
});
