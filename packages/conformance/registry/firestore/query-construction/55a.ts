import { row } from './section.ts';

export default row({
  order: 30,
  rowNumber: 55,
  featureKeys: ["and"],
  status: "conforms",
  automation: "oracle-backed",
  behavior: "**Existence + null filter guards (FS-B7)** -- a doc missing the filter field is never returned by `==`/`<`/`<=`/`>`/`>=`/`in`/`!=`/`not-in`; `!=`, `in`, and `not-in` exclude null-valued docs (only `== null` matches explicit null); a `null` in a `not-in` operand list matches nothing.",
  evidence: "`unit:admin-compat/inequality-existence-guards.test.ts`, `oracle:firestore-where-existence-and-null-guards`",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts 4 specific value(s)"],
  oracleObservations: ["firestore-where-existence-and-null-guards"],
  conformanceTests: ["packages/pyric/test/sandbox/firestore/admin-compat/inequality-existence-guards.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-query-construction.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-query-construction.test.ts"],
});
