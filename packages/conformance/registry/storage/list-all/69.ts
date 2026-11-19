import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "Empty bucket → both arrays empty, `nextPageToken: undefined`",
  evidence: "`oracle:storage-listall-empty-and-result-shape` (`emptyDirectory`: `itemCount: 0`, `prefixCount: 0`, `nextPageToken === undefined`, `'nextPageToken' in res === false`), replayed across `oracle-conformance.test.ts`, `storage-listall-parity.test.ts`, and `hosted-sqlite.test.ts`",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  oracleObservations: ["storage-listall-empty-and-result-shape"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts", "packages/cli/test/serve/worker/storage-listall-parity.test.ts", "packages/cli/test/serve/hosted-sqlite.test.ts", "packages/pyric/test/storage/list.test.ts"],
});
