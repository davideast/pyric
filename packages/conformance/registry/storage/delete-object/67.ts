import { row } from './section.ts';

export default row({
  order: 50,
  behavior: "Sandbox: writes-then-delete leaves no metadata (post-delete `getMetadata` throws `object-not-found`)",
  status: "conforms",
  evidence: "Production observation `storage-delete-then-getmetadata-throws` (firebase 12.19.0) uploads a 5-byte payload with `customMetadata: { stage: 'before-delete' }`, verifies `getMetadata` reads the stored metadata (`metageneration: '1'`), deletes the object via `deleteObject`, and records `getMetadata` throwing `FirebaseError` (`code: 'storage/object-not-found'`). Replayed across the in-process `pyric/storage` surface (`oracle-conformance.test.ts`), the SharedWorker host/client (`storage-root-getblob-delete-metadata.test.ts`), and the Node-hosted SQLite byte route (`hosted-sqlite.test.ts`).",
  risk: ["specific-value","error-code","metadata"],
  riskScore: 6,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `object-not-found`","asserts metadata shape"],
  automation: "oracle-backed",
  oracleObservations: ["storage-delete-then-getmetadata-throws"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-root-getblob-delete-metadata.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts"],
});
