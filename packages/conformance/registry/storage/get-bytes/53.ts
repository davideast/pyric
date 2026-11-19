import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "Returns the blob's contents as an `ArrayBuffer`",
  evidence: "`oracle:storage-getbytes-roundtrip-and-cap` (`unbounded`: `isArrayBuffer: true`, `byteLength: 16`), replayed across `oracle-conformance.test.ts`, `storage-getbytes-uploadstring-parity.test.ts`, and `hosted-sqlite.test.ts`",
  automation: "oracle-backed",
  oracleObservations: ["storage-getbytes-roundtrip-and-cap"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-getbytes-uploadstring-parity.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts","packages/pyric/test/storage/reference.test.ts"],
});
