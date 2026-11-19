import { row } from './section.ts';

export default row({
  order: 80,
  behavior: "`updateDoc` through a converted ref does NOT invoke the converter",
  evidence: "`oracle:firestore-withconverter-updatedoc-bypasses-converter`",
  oracleObservations: ["firestore-withconverter-updatedoc-bypasses-converter"],
  conformanceTests: ["packages/pyric/test/firestore/oracle-captures/firestore-withconverter.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-withconverter.test.ts"],
});
