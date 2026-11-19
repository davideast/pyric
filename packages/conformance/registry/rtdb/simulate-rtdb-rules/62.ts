import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "Path variables (`$userId`) are bound from the URL path and exposed in `pathVariableBindings` (also without the `$` prefix for ergonomic access in expressions)",
  status: "conforms",
  evidence: "Oracle `rtdb-rules-cascade-bindings-and-auth-context` records `$userId` path-variable binding across read and write rules; replayed across `simulateRtdbRules`, sandbox, SharedWorker, and Node host alongside `unit:simulation/handler.test.ts`.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-rules-cascade-bindings-and-auth-context"],
  conformanceTests: ["packages/pyric/test/rules/rtdb/simulation/handler.test.ts", "packages/pyric/test/database/oracle-conformance.test.ts", "packages/cli/test/serve/worker/oracle-captures/rtdb-rules-evaluation-and-roundtrip.test.ts"],
});
