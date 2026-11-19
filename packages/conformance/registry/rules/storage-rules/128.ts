import { row } from './section.ts';

export default row({
  order: 280,
  featureKeys: ["request.resource"],
  behavior: "`request.resource` on delete where no incoming object exists: `request.resource == null`",
  status: "conforms",
  evidence: "GAP CLOSED, 2026-07-21: production errors when `request.resource` is absent on delete, including a direct null comparison. The evaluator now carries the absent incoming binding as a Rules error. `oracle:rules-storage-upload-primitives-boundaries` replays the captured DENY directly with no divergence pin; `unit:storage/sandbox/rules-evaluator.test.ts` covers the evaluator seam.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts rules-denial behavior"],
  automation: "oracle-backed",
  oracleObservations: ["rules-storage-upload-primitives-boundaries"],
  conformanceTests: ["packages/rules/test/storage/rules-oracle-conformance.test.ts"],
  constructs: ["storage.binding.request.resource"],
});
