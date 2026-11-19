import { row } from './section.ts';

export default row({
  order: 180,
  featureKeys: [],
  behavior: "`resource` on a create where no object exists: the create-if-absent guard `allow create: if resource == null`",
  status: "conforms",
  evidence: "GAP CLOSED, 2026-07-21: production raises a null-value error when `resource` is referenced on a create where no object exists, including `resource == null`, so the expression denies. The evaluator now represents the missing binding as a Rules error rather than a usable null. `oracle:rules-storage-verbs-umbrella-granular` replays the captured DENY directly with no divergence pin; `unit:storage/sandbox/rules-evaluator.test.ts` covers the evaluator seam.",
  risk: ["specific-value","rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts 1 specific value(s)","asserts rules-denial behavior"],
  automation: "oracle-backed",
  oracleObservations: ["rules-storage-verbs-umbrella-granular"],
  conformanceTests: ["packages/rules/test/storage/rules-oracle-conformance.test.ts"],
  constructs: ["storage.binding.resource"],
});
