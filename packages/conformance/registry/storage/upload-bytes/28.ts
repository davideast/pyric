import { row } from './section.ts';

export default row({
  order: 50,
  behavior: "`Blob.type === ''` (no intrinsic type) falls through to `application/octet-stream`, NOT to `''`",
  evidence: "Production observation `storage-uploadbytes-contenttype-precedence` (firebase 12.19.0) records `emptyBlobNoHint` storing and returning `application/octet-stream` (`size: 4`, `[82, 73, 70, 70]`). Replayed across all three planes.",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts 1 specific value(s)"],
  oracleObservations: ["storage-uploadbytes-contenttype-precedence"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-uploadbytes-parity.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts","packages/pyric/test/storage/reference.test.ts"],
});
