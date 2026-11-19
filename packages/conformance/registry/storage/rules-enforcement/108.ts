import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "`deleteObject` against a denied path throws `storage/unauthorized`",
  evidence: "`oracle:storage-rules-denied-metadata-and-delete` (`deleteObjectOutsideGrant`, `deleteObjectSignedOutExisting`, and `existingPreservedAfterDenials`), replayed across `oracle-conformance.test.ts`, `storage-delete-listall-rules-parity.test.ts`, and `hosted-sqlite.test.ts`",
  risk: ["specific-value","error-code","rules-denial"],
  riskScore: 7,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `storage/unauthorized`","asserts rules-denial behavior"],
  automation: "oracle-backed",
  oracleObservations: ["storage-rules-denied-metadata-and-delete"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-delete-listall-rules-parity.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts","packages/pyric/test/storage/enforce.test.ts"],
});
