import { row } from './section.ts';

export default row({
  order: 60,
  behavior: "`setDoc` through a converted ref invokes `toFirestore(data)`",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-withconverter-setdoc-invokes-tofirestore`",
  oracleObservations: ["firestore-withconverter-setdoc-invokes-tofirestore"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-withconverter.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-withconverter.test.ts"],
});
