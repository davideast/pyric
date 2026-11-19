import { row } from './section.ts';

export default row({
  order: 540,
  featureKeys: ["resource.bucket", "request.resource.bucket"],
  behavior: "The bucket wildcard, `request.resource.bucket` and `resource.bucket` carry the real bucket name, so a ruleset that names its bucket is honored",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "`oracle:rules-storage-storage-named-bucket-binding` (captured 2026-10-27, 4 cases) records production binding the real bucket name in all three places. The evaluator, given the case's bucket, agrees on all 4; `unit:storage/rules-oracle-conformance.test.ts` replays them with no pin. The live planes bind the same name: the in-page plane from the app's `storageBucket` or `getStorage`'s bucket URL, the SharedWorker and Node host from the name the caller knows the bucket by, and simulate, the `storage` methods and `pyric verify` from the served app's `storageBucket` or the name the live op recorded (`unit:storage/sandbox/rules-bucket-name.test.ts`, `test/apps/storage-rules-bucket-name`).",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts rules-denial behavior"],
  oracleObservations: ["rules-storage-storage-named-bucket-binding"],
  conformanceTests: ["packages/rules/test/storage/rules-oracle-conformance.test.ts"],
});
