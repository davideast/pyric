import { row } from './section.ts';

export default row({
  order: 250,
  featureKeys: [],
  behavior: "Request-target `resource` on a missing document (RULES-B13) — get/update/delete existence guards, null comparison, and data access all error to DENY",
  status: "conforms",
  evidence: "NEW ROW, 2026-07-12: production capture proves the simulator matches the Firestore Rules Test API verdict-for-verdict on all 9 cases. A missing request target makes the `resource` global an error value: `resource != null`, `resource == null`, and `resource.data.value` all DENY. The simulator previously constructed `{ data: {} }` for missing get/update/delete requests, so the ordinary `resource != null` existence guard false-ALLOWed all three operations. Modeling the target as raw null fixes that guard but makes `resource == null` false-ALLOW, so the evaluator now raises `Null value error.` when the absent `resource` identifier itself is evaluated. Existing-document get/update/delete and data-access controls still ALLOW. `oracle:rules-firestore-resource-missing-document` — replayed by `packages/pyric/test/rules/oracle-conformance.test.ts`.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts rules-denial behavior"],
  oracleObservations: ["rules-firestore-resource-missing-document"],
  constructs: ["firestore.binding.resource","firestore.binding.resource.data"],
});
