import { row } from './section.ts';

export default row({
  order: 560,
  featureKeys: ["match"],
  behavior: "A root match that names its bucket literally grants only that bucket; a request in another bucket, including a bucket name that extends it, matches no rule and denies",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "`oracle:rules-storage-xref-root-literal-bucket` (captured 2026-10-27, 5 cases) records production ALLOWING `get` and `create` in the named bucket and DENYING them in another bucket and in `demo-pyric.appspot.com2`. The evaluator agrees on all 5, so the Firestore root-path fail-open (FS2-ENF-1) does not reach Storage. `unit:storage/rules-oracle-conformance.test.ts` replays them with no pin.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts rules-denial behavior at the bucket boundary"],
  oracleObservations: ["rules-storage-xref-root-literal-bucket"],
  conformanceTests: ["packages/rules/test/storage/rules-oracle-conformance.test.ts"],
});
