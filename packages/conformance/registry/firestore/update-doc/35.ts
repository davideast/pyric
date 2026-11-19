import { row } from './section.ts';

export default row({
  order: 30,
  automation: "oracle-backed",
  oracleObservations: ["firestore-crud-converter-delete-and-adddoc"],
  behavior: "Does NOT run a converter -- partial updates don't have a typed home (matches JS SDK)",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-crud-converter-delete-and-adddoc` (`updateDocBypass.toCallsUnchanged: true` and `fromCallsUnchangedDuringWrite: true` on `firebase/firestore` 12.19.0)",
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-crud-cursors-listeners.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-crud-cursors-listeners.test.ts"],
});
