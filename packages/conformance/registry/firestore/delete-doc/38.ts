import { row } from './section.ts';

export default row({
  order: 10,
  automation: "oracle-backed",
  oracleObservations: ["firestore-crud-converter-delete-and-adddoc"],
  behavior: "Removes the document; subsequent `getDoc` returns `exists()===false`",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-crud-converter-delete-and-adddoc` (`existsAfterDelete: false`, `dataUndefinedAfterDelete: true`)",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-crud-cursors-listeners.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-crud-cursors-listeners.test.ts"],
});
