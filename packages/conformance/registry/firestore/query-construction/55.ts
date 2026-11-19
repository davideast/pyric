import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["where"],
  status: "conforms",
  automation: "oracle-backed",
  behavior: "`where(field, op, value)` -- all 10 ops: `<`, `<=`, `==`, `>=`, `>`, `!=`, `in`, `not-in`, `array-contains`, `array-contains-any`",
  evidence: "`unit:sandbox-target.test.ts`, `unit:upstream-query-probes.test.ts`, `oracle:firestore-where-ten-filter-operators`",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts 3 specific value(s)"],
  oracleObservations: ["firestore-where-ten-filter-operators"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/upstream-query-probes.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-query-construction.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-query-construction.test.ts"],
});
