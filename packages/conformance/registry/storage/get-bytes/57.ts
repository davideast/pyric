import { row } from './section.ts';

export default row({
  order: 50,
  behavior: "Throws `storage/invalid-root-operation` when called on the root reference",
  evidence: "`oracle:client-storage-getbytes-root-ref` (`threwSynchronously: true`, `code: 'storage/invalid-root-operation'`, `fetchCalls: 0`), replayed across `oracle-conformance.test.ts`, `storage-getbytes-uploadstring-parity.test.ts`, and `hosted-sqlite.test.ts`",
  risk: ["specific-value","error-code"],
  riskScore: 5,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `storage/invalid-root-operation`"],
  automation: "oracle-backed",
  oracleObservations: ["client-storage-getbytes-root-ref"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-getbytes-uploadstring-parity.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts","packages/pyric/test/storage/reference.test.ts"],
});
