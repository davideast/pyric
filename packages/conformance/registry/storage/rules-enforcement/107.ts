import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "`updateMetadata` against a denied path throws `storage/unauthorized`",
  evidence: "`oracle:storage-rules-denied-metadata-and-delete` (`updateMetadataOutsideGrant`, `updateMetadataSignedOutExisting`, and `existingPreservedAfterDenials`), replayed across `oracle-conformance.test.ts`, `storage-delete-listall-rules-parity.test.ts`, and `hosted-sqlite.test.ts`",
  risk: ["specific-value","error-code","rules-denial","metadata"],
  riskScore: 8,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `storage/unauthorized`","asserts rules-denial behavior","asserts metadata shape"],
  automation: "oracle-backed",
  oracleObservations: ["storage-rules-denied-metadata-and-delete"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-delete-listall-rules-parity.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts","packages/pyric/test/storage/enforce.test.ts"],
});
