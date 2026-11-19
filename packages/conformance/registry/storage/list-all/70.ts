import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "Direct children only — does NOT recurse into grandchildren as items",
  evidence: "`oracle:storage-listall-hierarchy-dedup-and-self-exclusion` (`grandchildrenIncludedInItems: false`, `itemNames: ['direct-one.bin', 'direct-two.bin']`), replayed across `oracle-conformance.test.ts`, `storage-listall-parity.test.ts`, and `hosted-sqlite.test.ts`",
  oracleObservations: ["storage-listall-hierarchy-dedup-and-self-exclusion"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts", "packages/cli/test/serve/worker/storage-listall-parity.test.ts", "packages/cli/test/serve/hosted-sqlite.test.ts", "packages/pyric/test/storage/list.test.ts"],
});
