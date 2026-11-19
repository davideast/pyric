import { row } from './section.ts';

export default row({
  order: 90,
  featureKeys: ["updateMetadata"],
  behavior: "Client `updateMetadata` throws `storage/unauthorized` for missing paths across all client planes (including unconditional allow rules and open/permissive mode; admin plane retains `object-not-found`)",
  status: "conforms",
  evidence: "oracle: `packages/conformance/observations/storage/storage-metadata-missing-object-errors.json` (under unconditional `allow read, write: if request.auth != null`, `getMetadata` returns 404 `storage/object-not-found` while client `updateMetadata` returns 403 `storage/unauthorized` because `firebasestorage.googleapis.com` requires an existing object to synthesize `request.resource`) + `unit:metadata.test.ts`",
  risk: ["specific-value","error-code","metadata"],
  riskScore: 6,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `storage/unauthorized`","asserts metadata shape"],
  automation: "oracle-backed",
  oracleObservations: ["storage-metadata-missing-object-errors"],
  conformanceTests: ["packages/pyric/test/storage/metadata.test.ts", "packages/pyric/test/storage/oracle-conformance.test.ts", "packages/cli/test/serve/worker/storage-metadata-parity.test.ts", "packages/cli/test/serve/hosted-sqlite.test.ts"],
});
