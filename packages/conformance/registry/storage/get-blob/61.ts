import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "Root-ref read throws `storage/invalid-root-operation`",
  evidence: "Production observation `client-storage-getblob-root-ref` (firebase 12.19.0) records `browserRootRef` throwing `FirebaseError` synchronously (`threwSynchronously: true`, `code: 'storage/invalid-root-operation'`, `fetchCalls: 0`) before any network request, while `nodeEntryRootRef` throws the Node bundle browser-environment guard synchronously. Replayed across the in-process `pyric/storage` surface (`oracle-conformance.test.ts`), the served page/worker client (`storage-root-getblob-delete-metadata.test.ts`), and the Node-hosted SQLite byte route (`hosted-sqlite.test.ts`).",
  risk: ["specific-value","error-code"],
  riskScore: 5,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `storage/invalid-root-operation`"],
  automation: "oracle-backed",
  oracleObservations: ["client-storage-getblob-root-ref"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-root-getblob-delete-metadata.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts"],
});
