import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "Sub-folders surface as `prefixes` and are deduplicated (many files under one folder → ONE prefix entry)",
  evidence: "`oracle:storage-listall-hierarchy-dedup-and-self-exclusion` (3 objects under `shared-folder` collapse to 1 `shared-folder` prefix alongside `deep-folder`), replayed across `oracle-conformance.test.ts`, `storage-listall-parity.test.ts`, and `hosted-sqlite.test.ts`",
  oracleObservations: ["storage-listall-hierarchy-dedup-and-self-exclusion"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts", "packages/cli/test/serve/worker/storage-listall-parity.test.ts", "packages/cli/test/serve/hosted-sqlite.test.ts", "packages/pyric/test/storage/list.test.ts"],
});
