import { row } from './section.ts';

export default row({
  order: 60,
  behavior: "Caller's `metadata.contentType` beats data_url inference",
  status: "conforms",
  evidence: "`oracle:storage-uploadstring-data-url-variants` (`callerContentTypeOverride`: `text/csv` beats `text/plain`), replayed across `oracle-conformance.test.ts`, `storage-getbytes-uploadstring-parity.test.ts`, and `hosted-sqlite.test.ts`",
  risk: ["metadata"],
  riskScore: 1,
  riskReasons: ["asserts metadata shape"],
  automation: "oracle-backed",
  oracleObservations: ["storage-uploadstring-data-url-variants"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-getbytes-uploadstring-parity.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts","packages/pyric/test/storage/reference.test.ts"],
});
