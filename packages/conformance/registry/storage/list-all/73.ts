import { row } from './section.ts';

export default row({
  order: 60,
  behavior: "`prefixes` sorted lexicographically by `fullPath` (for determinism)",
  evidence: "`oracle:storage-listall-lexicographic-order` (`observedPrefixNames: ['p-10', 'p-2', 'p-B', 'p-a', 'p-z']`), replayed across `oracle-conformance.test.ts`, `storage-listall-parity.test.ts`, and `hosted-sqlite.test.ts`",
  oracleObservations: ["storage-listall-lexicographic-order"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts", "packages/cli/test/serve/worker/storage-listall-parity.test.ts", "packages/cli/test/serve/hosted-sqlite.test.ts", "packages/pyric/test/storage/list.test.ts"],
});
