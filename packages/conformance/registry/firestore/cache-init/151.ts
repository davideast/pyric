import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: ["Firestore", "CollectionReference", "DocumentReference", "DocumentSnapshot", "Query", "QueryDocumentSnapshot", "QuerySnapshot", "Transaction", "WriteBatch", "SnapshotMetadata", "FirestoreError", "AbstractUserDataWriter", "CACHE_SIZE_UNLIMITED", "AggregateField", "AggregateQuerySnapshot", "QueryCompositeFilterConstraint", "QueryConstraint", "QueryFieldFilterConstraint", "QueryLimitConstraint", "QueryOrderByConstraint", "QueryStartAtConstraint", "QueryEndAtConstraint"],
  api: "Runtime ES Classes / Constructor Tokens",
  behavior: "Exports ES classes and constructor tokens matching structural type handles for instanceof checks and prototype inheritance",
  status: "conforms",
  evidence: "`unit:firestore/runtime-classes.test.ts`, oracle: `firestore-runtime-classes-and-instanceof.json`",
  automation: "oracle-backed",
  oracleObservations: ["firestore-runtime-classes-and-instanceof"],
  conformanceTests: ["packages/pyric/test/firestore/runtime-classes.test.ts","packages/pyric/test/firestore/oracle-captures/firestore-txn-batch-equality-classes.test.ts","packages/cli/test/serve/worker/oracle-captures/firestore-txn-batch-equality-classes.test.ts"],
});
