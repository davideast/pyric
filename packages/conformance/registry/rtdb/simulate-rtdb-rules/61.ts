import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "Walks ancestors from root -> target; the first ancestor whose rule expression evaluates to `true` grants access - matches RTDB's documented \"rules cascade from root, true at any ancestor grants\" semantics",
  status: "conforms",
  evidence: "Oracle `rtdb-rules-cascade-bindings-and-auth-context` records ancestor `true` overriding descendant `false`; replayed across `simulateRtdbRules`, sandbox, SharedWorker, and Node host alongside `unit:simulation/handler.test.ts`.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-rules-cascade-bindings-and-auth-context"],
  conformanceTests: ["packages/pyric/test/rules/rtdb/simulation/handler.test.ts", "packages/pyric/test/database/oracle-conformance.test.ts", "packages/cli/test/serve/worker/oracle-captures/rtdb-rules-evaluation-and-roundtrip.test.ts"],
});
