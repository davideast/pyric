import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["getDocFromServer","getDocsFromServer"],
  api: "getDocFromServer / getDocsFromServer",
  behavior: "Delegates to `getDoc` / `getDocs` in the sandbox mirror - the sandbox store IS the authoritative source, returning live server snapshots (`fromCache: false`)",
  status: "conforms",
  evidence: "`unit:firestore/tier1-cache-init-align.test.ts`, oracle: `firestore-refequal-and-aggregate-equality.json`",
  automation: "oracle-backed",
  oracleObservations: ["firestore-refequal-and-aggregate-equality"],
  conformanceTests: ["packages/pyric/test/firestore/tier1-cache-init-align.test.ts","packages/pyric/test/firestore/oracle-captures/firestore-txn-batch-equality-classes.test.ts","packages/cli/test/serve/worker/oracle-captures/firestore-txn-batch-equality-classes.test.ts"],
});
