import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["parseStorageRules"],
  behavior: "A Storage ruleset declaring a non-`firebase.storage` service header (`service cloud.firestore` or an unknown `service foo.bar`) compiles without error and denies every Storage request",
  status: "conforms",
  evidence: "`oracle:rules-storage-service-name-firestore-in-storage` (0 compile issues, DENY) and `oracle:rules-storage-service-name-unknown-in-storage` (`WARNING@2:9 Invalid service name: foo.bar.`, DENY); `parseStorageRules` and `storageRules()` compile non-Storage service headers to a deny-all handle while `lint()` surfaces `INVALID_SERVICE_NAME` / `MISSING_STORAGE_SERVICE` warnings",
  oracleObservations: ["rules-storage-service-name-firestore-in-storage", "rules-storage-service-name-unknown-in-storage"],
  conformanceTests: ["packages/rules/test/storage/rules-oracle-conformance.test.ts", "packages/rules/test/storage/sandbox/rules.test.ts", "packages/rules/test/api/storage-rules.test.ts", "packages/rules/test/linter/service-declarations.test.ts"],
});
