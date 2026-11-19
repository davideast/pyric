import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["documentId"],
  automation: "oracle-backed",
  behavior: "`documentId()` works in `where(documentId(), …)` / `orderBy(documentId())` against the sandbox — string ids, DocumentReference operands, ranges, and id sort",
  evidence: "`unit:upstream-query-probes.test.ts` (`documentId() filters + orderBy`); modular `where`/`orderBy` accept `FieldPath`; `oracle:firestore-query-documentid-and-nested-fieldpath`",
  oracleObservations: ["firestore-query-documentid-and-nested-fieldpath"],
  conformanceTests: ["packages/pyric/test/firestore/upstream-query-probes.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-sentinels-scalars.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-sentinels-scalars.test.ts"],
});
