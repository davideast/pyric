import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["setRules"],
  api: "Rules `match /databases/{database}/documents`",
  behavior: "Rules evaluate the `database` path variable as `(default)` for every request, whatever database id the handle was created with. Production binds the named database's id.",
  statusNote: "`database` is always (default)",
  evidence: "`packages/pyric/test/firestore/named-database.test.ts` writes through a handle created for `reports`: a rule requiring `database == '(default)'` allows the write and a rule requiring `database == 'reports'` denies it.",
  conformanceTests: ["packages/pyric/test/firestore/named-database.test.ts"],
  oracleObservations: ["firestore-named-database-rules-api", "firestore-named-database-cross-database"],
});
