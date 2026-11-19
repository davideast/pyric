import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "When the object exceeds `maxDownloadSize`, returns a truncated prefix of that byte length (does not throw)",
  evidence: "`oracle:storage-getbytes-roundtrip-and-cap` (`truncatedMax6`: `threw: false`, `byteLength: 6`, `bytes: [0..5]`), replayed across `oracle-conformance.test.ts`, `storage-getbytes-uploadstring-parity.test.ts`, and `hosted-sqlite.test.ts`",
  risk: ["specific-value"],
  riskScore: 1,
  riskReasons: ["asserts truncated byte length and contents"],
  automation: "oracle-backed",
  oracleObservations: ["storage-getbytes-roundtrip-and-cap"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-getbytes-uploadstring-parity.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts","packages/pyric/test/storage/upstream-storage-probes.test.ts"],
});
