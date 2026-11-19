import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "Throws `storage/object-not-found` when no object exists at the path",
  evidence: "`unit:reference.test.ts` (\"throws storage/object-not-found for missing paths\") + oracle: `packages/conformance/observations/storage/storage-delete-then-get-throws.json` (against digame-mas, fb-js-sdk 12.19.0: upload -> delete -> `getDownloadURL` on the deleted ref throws `FirebaseError` with `code: 'storage/object-not-found'`)",
  risk: ["specific-value","error-code"],
  riskScore: 5,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `storage/object-not-found`"],
  automation: "oracle-backed",
  oracleObservations: ["storage-delete-then-get-throws"],
  conformanceTests: ["packages/pyric/test/storage/reference.test.ts"],
});
