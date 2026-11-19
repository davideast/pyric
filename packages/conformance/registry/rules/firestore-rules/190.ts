import { row } from './section.ts';

export default row({
  order: 310,
  featureKeys: ["getAfter", "batch", "transaction"],
  behavior: "In multi-document batched writes and transactions, getAfter() on a document the batch updates returns the stored document with the update's field mask applied: fields the update does not name keep their stored values, and a nested map the update names is replaced, not merged.",
  status: "conforms",
  evidence: "`oracle:rules-firestore-atomic-batch-sibling-merge` records authenticated Web SDK verdicts against temporarily deployed production rules via `run-firestore-sibling-merge.ts` (`siblingMergeProbePlan`): a batch updating only `modified` on a seeded `{ role: 'admin', modified: false }` companion alongside a sibling create reading both `role` and `modified` through `getAfter()` answers `ALLOW`, while the solo create without the batch update answers `DENY` and a two-field update batch control answers `ALLOW` (`diagnostics.productionDatabase`, `lifecycle.restoredOriginalRelease: true`, and retained `hostedTestApiLimitation` documenting the hosted Rules Test API `Function not found: getAfter` boundary). Replayed verdict-for-verdict through `LocalEnvironment` in `packages/conformance/test/src/firestore-real-sibling-merge.test.ts` and `packages/pyric/test/rules/oracle-conformance.test.ts`, with nested-map replacement and multi-document batch field-mask coverage in `get-after-batch.test.ts`.",
  automation: "oracle-backed",
  oracleObservations: ["rules-firestore-atomic-batch-sibling-merge"],
  conformanceTests: [
    "packages/pyric/test/rules/oracle-conformance.test.ts",
    "packages/pyric/test/sandbox/firestore/simulator/get-after-batch.test.ts",
    "packages/conformance/test/src/firestore-real-sibling-merge.test.ts",
  ],
  constructs: ["firestore.function.getAfter"],
});
