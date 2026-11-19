import { row } from './section.ts';

export default row({
  order: 120,
  behavior: "Replaces any existing object at the path (overwrite, not append)",
  evidence: "Production observation `storage-uploadbytes-overwrite-generations` (firebase 12.19.0) uploads 7 bytes (`application/octet-stream`, `{ revision: 'first', extra: 'removed-on-overwrite' }`) then 3 bytes (`[10, 20, 30]`, `application/json`, `{ revision: 'second' }`), confirming `size: 3`, exact replacement bytes `[10, 20, 30]`, and replaced `customMetadata`. Replayed across all three planes.",
  risk: ["specific-value"],
  riskScore: 1,
  riskReasons: ["asserts overwritten bytes and contentType"],
  oracleObservations: ["storage-uploadbytes-overwrite-generations"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-uploadbytes-parity.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts","packages/pyric/test/storage/upstream-storage-probes.test.ts"],
});
