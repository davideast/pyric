import { row } from './section.ts';

export default row({
  order: 10,
  status: "conforms",
  automation: "oracle-backed",
  oracleObservations: ["firestore-crud-converter-delete-and-adddoc"],
  behavior: "Returns a tagged `DocumentReference` with auto-id",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-crud-converter-delete-and-adddoc` (`refType: 'document'`, `autoIdLength: 20`, `autoIdAlphanumeric: true`, `parentPathMatches: true`)",
  risk: ["structural"],
  riskReasons: ["structural / routing-only claim"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-crud-cursors-listeners.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-crud-cursors-listeners.test.ts"],
});
