import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "`format='raw'` (default): UTF-8 encodes the string; `contentType` defaults to `application/octet-stream`",
  status: "conforms",
  evidence: "`oracle:storage-uploadstring-raw-and-base64` (`defaultRaw` and `explicitRaw`: `application/octet-stream`), replayed across `oracle-conformance.test.ts`, `storage-getbytes-uploadstring-parity.test.ts`, and `hosted-sqlite.test.ts`",
  risk: ["metadata"],
  riskScore: 1,
  riskReasons: ["asserts metadata shape"],
  automation: "oracle-backed",
  oracleObservations: ["storage-uploadstring-raw-and-base64"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-getbytes-uploadstring-parity.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts","packages/pyric/test/storage/reference.test.ts"],
});
