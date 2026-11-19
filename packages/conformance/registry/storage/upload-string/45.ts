import { row } from './section.ts';

export default row({
  order: 70,
  behavior: "Malformed `data_url` (missing `data:` prefix, missing comma, or invalid percent-encoding) synchronously throws `storage/invalid-format`",
  status: "conforms",
  evidence: "`oracle:client-storage-uploadstring-malformed-data-url` (`threwSynchronously: true`, `code: 'storage/invalid-format'`, `fetchCalls: 0`), replayed across `oracle-conformance.test.ts`, `storage-getbytes-uploadstring-parity.test.ts`, and `hosted-sqlite.test.ts`",
  risk: ["specific-value","error-code"],
  riskScore: 5,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `storage/invalid-format`"],
  automation: "oracle-backed",
  oracleObservations: ["client-storage-uploadstring-malformed-data-url"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-getbytes-uploadstring-parity.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts","packages/pyric/test/storage/reference.test.ts"],
});
