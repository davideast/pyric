import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["getFirestore"],
  api: "pyric-admin getFirestore(app, databaseId)",
  behavior: "`pyric-admin` `getFirestore` takes no database id; a second argument is ignored and the handle reads and writes `(default)`. The Admin SDK's `getFirestore(app, databaseId)` selects the named database.",
  statusNote: "no database id parameter; every call resolves to (default)",
  evidence: "`packages/pyric-admin/test/firestore/named-database.test.ts` writes through `getFirestore(app, 'reports')` and reads the document through `getFirestore(app)` and `getFirestore(app, 'archive')`.",
  conformanceTests: ["packages/pyric-admin/test/firestore/named-database.test.ts"],
  oracleObservations: ["firestore-named-database-admin-mixing"],
});
