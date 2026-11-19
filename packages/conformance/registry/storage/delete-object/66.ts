import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "Prod: a successful `deleteObject` followed by `getDownloadURL` on the same ref throws `storage/object-not-found`",
  status: "conforms",
  statusNote: "(prod-only)",
  evidence: "oracle: `packages/conformance/observations/storage/storage-delete-then-get-throws.json` (against digame-mas, fb-js-sdk 12.19.0: upload + delete succeed, then `getDownloadURL` throws `code: 'storage/object-not-found'`, message `\"Firebase Storage: Object '…' does not exist.\"`, `isFirebaseError: true`)",
  risk: ["specific-value","error-code","specific-field"],
  riskScore: 6,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `storage/object-not-found`","asserts a specific field/property value"],
  automation: "oracle-backed",
  oracleObservations: ["storage-delete-then-get-throws"],
});
