import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "Accepts `Blob` payload; returns `UploadResult` with populated `metadata`",
  evidence: "Production observation `storage-uploadbytes-payload-types` (firebase 12.19.0) uploads a 4-byte `Blob`, reads back `[0, 127, 128, 255]` via `getBytes`, and verifies `result.ref` and `result.metadata` (`size: 4`, `fullPath`, `name`, `bucket`). Replayed across `pyric/storage`, the SharedWorker served entry, and the Node-hosted SQLite byte route.",
  risk: ["metadata"],
  riskScore: 1,
  riskReasons: ["asserts metadata shape"],
  oracleObservations: ["storage-uploadbytes-payload-types"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-uploadbytes-parity.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts","packages/pyric/test/storage/reference.test.ts"],
});
