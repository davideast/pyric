import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "Throws `storage/object-not-found` when called on a missing path",
  status: "conforms",
  evidence: "Production observation `storage-delete-missing-throws` (firebase 12.19.0) records `deleteObject` on a missing path rejecting with `FirebaseError` (`code: 'storage/object-not-found'`, `threw: true`). Rules evaluate before checking existence so unauthorized callers still receive `storage/unauthorized`; replayed across `oracle-conformance.test.ts`, `storage-delete-listall-rules-parity.test.ts`, and `hosted-sqlite.test.ts`.",
  risk: ["specific-value","error-code","specific-field"],
  riskScore: 6,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `storage/object-not-found`","asserts a specific field/property value"],
  automation: "oracle-backed",
  oracleObservations: ["storage-delete-missing-throws"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-delete-listall-rules-parity.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts","packages/pyric/test/storage/reference.test.ts"],
});
