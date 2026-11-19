import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["getFirestore"],
  api: "getFirestore(app, databaseId)",
  behavior: "In the sandbox, `getFirestore(app, databaseId)` ignores the database id and returns the app's `(default)` handle, so documents written under one id are read under every other id.",
  statusNote: "every database id resolves to (default)",
  evidence: "`packages/pyric/test/firestore/named-database.test.ts` asserts two database ids return the `(default)` handle and that a document written under one id reads back under another.",
  conformanceTests: ["packages/pyric/test/firestore/named-database.test.ts"],
  oracleObservations: ["firestore-named-database-absent"],
});
