import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "`withConverter(docRef, converter)` returns a shell that runs `toFirestore` on writes, `fromFirestore` on reads",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-withconverter-doc-roundtrip`",
  oracleObservations: ["firestore-withconverter-doc-roundtrip"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-withconverter.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-withconverter.test.ts"],
});
