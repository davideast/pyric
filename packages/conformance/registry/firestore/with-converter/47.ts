import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "`withConverter(collRef, converter)` propagates onto `doc(typedColl, id)`",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-withconverter-collection-propagates-to-doc`",
  oracleObservations: ["firestore-withconverter-collection-propagates-to-doc"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-withconverter.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-withconverter.test.ts"],
});
