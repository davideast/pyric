import { row } from './section.ts';

export default row({
  order: 90,
  behavior: "Items expose the full `StorageReference` shape (storage, bucket, name, parent)",
  evidence: "`oracle:storage-listall-empty-and-result-shape` (`items` and `prefixes` preserve `storage`, `bucket`, `name`, `fullPath`, `parent`, `root`, and `toString()`), replayed across `oracle-conformance.test.ts`, `storage-listall-parity.test.ts`, and `hosted-sqlite.test.ts`",
  oracleObservations: ["storage-listall-empty-and-result-shape"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts", "packages/cli/test/serve/worker/storage-listall-parity.test.ts", "packages/cli/test/serve/hosted-sqlite.test.ts", "packages/pyric/test/storage/list.test.ts"],
});
