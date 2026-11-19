import { row } from './section.ts';

export default row({
  order: 80,
  behavior: "`listAll(ref(storage))` (root) scans the entire bucket",
  evidence: "`oracle:storage-listall-root-ref` (`rootFullPath: ''`, `containsSeededRootItem: true`, `containsSeededRootPrefix: true`, `nestedChildExcludedFromRootItems: true`, `nextPageTokenIsUndefined: true`, plus GCS trailing-slash prefix ordering), replayed across `oracle-conformance.test.ts`, `storage-delete-listall-rules-parity.test.ts`, and `hosted-sqlite.test.ts`",
  automation: "oracle-backed",
  oracleObservations: ["storage-listall-root-ref"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts", "packages/cli/test/serve/worker/storage-delete-listall-rules-parity.test.ts", "packages/cli/test/serve/hosted-sqlite.test.ts", "packages/pyric/test/storage/list.test.ts"],
});
