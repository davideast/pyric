import { row } from './section.ts';

export default row({
  order: 10,
  automation: "oracle-backed",
  behavior: "No options (or `{ merge: false }`) replaces the existing document completely",
  evidence: "`unit:sandbox-target.test.ts` (\"setDoc default replaces\"), `oracle:firestore-setdoc-default-replaces-entire-doc`",
  oracleObservations: ["firestore-setdoc-default-replaces-entire-doc"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-setdoc.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-setdoc.test.ts"],
});
