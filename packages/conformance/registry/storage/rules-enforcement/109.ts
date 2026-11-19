import { row } from './section.ts';

export default row({
  order: 50,
  behavior: "Ordinary SDK object paths are evaluated under Firebase Storage's canonical `/b/{bucket}/o/{object}` rules namespace while metadata preserves the ordinary object path",
  evidence: "`oracle:storage-rules-canonical-bucket-namespace` (`ordinaryObjectPath.startsWithCanonicalBucketPrefix: false`, `metadataMatchesRefFullPath: true`, `explicitRulesPrefixPath.uploadCode: 'storage/unauthorized'`), replayed across `oracle-conformance.test.ts`, `storage-delete-listall-rules-parity.test.ts`, and `hosted-sqlite.test.ts`",
  risk: ["specific-value","rules-denial","metadata"],
  riskScore: 6,
  riskReasons: ["asserts 1 specific value(s)","asserts rules allow/deny routing behavior","asserts metadata shape"],
  automation: "oracle-backed",
  oracleObservations: ["storage-rules-canonical-bucket-namespace"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-delete-listall-rules-parity.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts","packages/pyric/test/storage/enforce.test.ts"],
});
