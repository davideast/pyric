import { row } from './section.ts';

export default row({
  order: 80,
  behavior: "Throws `storage/invalid-root-operation` synchronously when called on the root reference",
  evidence: "Production observation `client-storage-uploadbytes-root-ref` (firebase 12.19.0) records `threwSynchronously: true`, `code: 'storage/invalid-root-operation'`, `fetchCalls: 0`. `uploadBytes` checks `guardNonRoot` / `guardClientNonRoot` synchronously before returning the upload promise across `pyric/storage`, the SharedWorker served entry, and the Node-hosted client.",
  risk: ["specific-value","error-code"],
  riskScore: 5,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `storage/invalid-root-operation`"],
  oracleObservations: ["client-storage-uploadbytes-root-ref"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-uploadbytes-parity.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts","packages/pyric/test/storage/reference.test.ts"],
});
