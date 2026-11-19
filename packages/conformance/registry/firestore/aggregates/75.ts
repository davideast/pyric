import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["getCountFromServer"],
  status: "conforms",
  automation: "oracle-backed",
  behavior: "`getCountFromServer` honors `where` filters (equality, range, `in`, composite `or()`, and zero-match filters)",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-getcountfromserver-where-filters`",
  oracleObservations: ["firestore-getcountfromserver-where-filters"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-aggregates.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-aggregates.test.ts"],
});
