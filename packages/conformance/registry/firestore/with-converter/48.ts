import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "`withConverter(collRef, converter)` propagates through `query(typedColl, ...)` + `getDocs()`",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-withconverter-collection-propagates-to-query-getdocs`",
  oracleObservations: ["firestore-withconverter-collection-propagates-to-query-getdocs"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-withconverter.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-withconverter.test.ts"],
});
