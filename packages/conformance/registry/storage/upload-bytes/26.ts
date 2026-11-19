import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "Accepts `ArrayBuffer` payload",
  evidence: "Production observation `storage-uploadbytes-payload-types` (firebase 12.19.0) uploads a sliced `ArrayBuffer` (`4` bytes) and reads back `[0, 127, 128, 255]` via `getBytes`. Replayed across all three planes.",
  oracleObservations: ["storage-uploadbytes-payload-types"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-uploadbytes-parity.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts","packages/pyric/test/storage/reference.test.ts"],
});
