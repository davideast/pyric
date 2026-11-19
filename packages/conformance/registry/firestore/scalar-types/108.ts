import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["FieldPath"],
  automation: "oracle-backed",
  behavior: "`FieldPath` (nested) works in queries against sandbox",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-query-documentid-and-nested-fieldpath`",
  oracleObservations: ["firestore-query-documentid-and-nested-fieldpath"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-sentinels-scalars.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-sentinels-scalars.test.ts"],
});
