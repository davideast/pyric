import { row } from './section.ts';

export default row({
  order: 70,
  behavior: "`getDoc` through a converted ref invokes `fromFirestore(snapshot)`; `.data()` returns the typed model",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-withconverter-getdoc-invokes-fromfirestore`",
  oracleObservations: ["firestore-withconverter-getdoc-invokes-fromfirestore"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-withconverter.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-withconverter.test.ts"],
});
