import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "`format='data_url'`: parses `data:<mime>;base64,<payload>`, infers `contentType` from prefix",
  status: "conforms",
  evidence: "`oracle:storage-uploadstring-data-url-variants` (`base64JsonDataUrl`: `application/json`, `size: 11`), replayed across `oracle-conformance.test.ts`, `storage-getbytes-uploadstring-parity.test.ts`, and `hosted-sqlite.test.ts`",
  risk: ["metadata"],
  riskScore: 1,
  riskReasons: ["asserts metadata shape"],
  automation: "oracle-backed",
  oracleObservations: ["storage-uploadstring-data-url-variants"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-getbytes-uploadstring-parity.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts","packages/pyric/test/storage/reference.test.ts"],
});
