import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "`format='base64'`: decodes payload bytes from standard base64",
  status: "conforms",
  evidence: "`oracle:storage-uploadstring-raw-and-base64` (`standardBase64`: `'AQID/w=='` -> `[1, 2, 3, 255]`, `application/octet-stream`), replayed across `oracle-conformance.test.ts`, `storage-getbytes-uploadstring-parity.test.ts`, and `hosted-sqlite.test.ts`",
  automation: "oracle-backed",
  oracleObservations: ["storage-uploadstring-raw-and-base64"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-getbytes-uploadstring-parity.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts","packages/pyric/test/storage/reference.test.ts"],
});
