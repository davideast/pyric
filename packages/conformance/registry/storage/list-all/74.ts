import { row } from './section.ts';

export default row({
  order: 70,
  behavior: "The scanned ref itself is NEVER included in `items` (even when an object exists at the exact prefix path)",
  evidence: "`oracle:storage-listall-hierarchy-dedup-and-self-exclusion` (`exactPrefixObjectExists: true`, `scannedRefIncludedInItems: false`), replayed across `oracle-conformance.test.ts`, `storage-listall-parity.test.ts`, and `hosted-sqlite.test.ts`",
  oracleObservations: ["storage-listall-hierarchy-dedup-and-self-exclusion"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts", "packages/cli/test/serve/worker/storage-listall-parity.test.ts", "packages/cli/test/serve/hosted-sqlite.test.ts", "packages/pyric/test/storage/list.test.ts"],
});
