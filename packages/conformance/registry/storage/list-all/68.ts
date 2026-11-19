import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "Returns `ListResult` with `items` (direct child files) + `prefixes` (sub-folder refs) + `nextPageToken: undefined`",
  evidence: "`oracle:storage-listall-empty-and-result-shape` (`populatedDirectory`: `items`, `prefixes`, `nextPageToken === undefined`, `'nextPageToken' in res === false`), replayed across `oracle-conformance.test.ts`, `storage-listall-parity.test.ts`, and `hosted-sqlite.test.ts`",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  oracleObservations: ["storage-listall-empty-and-result-shape"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts", "packages/cli/test/serve/worker/storage-listall-parity.test.ts", "packages/cli/test/serve/hosted-sqlite.test.ts", "packages/pyric/test/storage/list.test.ts"],
});
