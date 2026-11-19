import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "Just-under-cap reads succeed and return the full byte length",
  evidence: "`oracle:storage-getbytes-roundtrip-and-cap` (`exactMax16` and `aboveMax32`: `byteLength: 16`), replayed across `oracle-conformance.test.ts`, `storage-getbytes-uploadstring-parity.test.ts`, and `hosted-sqlite.test.ts`",
  automation: "oracle-backed",
  oracleObservations: ["storage-getbytes-roundtrip-and-cap"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-getbytes-uploadstring-parity.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts","packages/pyric/test/storage/upstream-storage-probes.test.ts"],
});
