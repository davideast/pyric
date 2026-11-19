import { row } from './section.ts';

export default row({
  order: 50,
  behavior: "`format='data_url'` with non-base64 payload: percent-decodes the body",
  status: "conforms",
  evidence: "`oracle:storage-uploadstring-data-url-variants` (`percentEncodedDataUrl`: `text/plain`, `'hello world!'`), replayed across `oracle-conformance.test.ts`, `storage-getbytes-uploadstring-parity.test.ts`, and `hosted-sqlite.test.ts`",
  risk: ["specific-value","error-code"],
  riskScore: 5,
  riskReasons: ["asserts decoded bytes","asserts Firebase error code(s): `storage/invalid-format`"],
  automation: "oracle-backed",
  oracleObservations: ["storage-uploadstring-data-url-variants"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-getbytes-uploadstring-parity.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts","packages/pyric/test/storage/upstream-storage-probes.test.ts"],
});
