import { row } from './section.ts';

export default row({
  order: 310,
  featureKeys: ["getAfter", "batch", "transaction"],
  behavior: "In multi-document batched writes and transactions, getAfter() on a document the batch updates returns the stored document with the update's field mask applied: fields the update does not name keep their stored values, and a nested map the update names is replaced, not merged.",
  status: "unverified",
  evidence: "Unverified, 2026-11-01 (#1322): no capture with this probe's controls backs this row yet. The Rules Test API cannot evaluate `getAfter()`. The committed `rules-firestore-atomic-batch-sibling-merge` observation is a real-database capture from before `firestore-real-sibling-merge.ts`, with no two-field ALLOW control, and its `hostedTestApiLimitation` diagnostic records `Function not found error: Name: [getAfter]`. The weekly re-capture on the oracle project answers DENY for the same case, and that DENY is the same Test API error (`Function not found error: Name: [getAfter]`), not an answer from a database. The corpus case it replays is also not a batch: it is a single create with a `get` mock that already holds both fields. The real-database rig's cross-document batch probe (`crossDocumentBatch` in `rules-firestore-get-after-and-exists-after`) updates a companion document whose only field is the one the batch changes, so it does not test a field the batch leaves alone. `run-firestore-real.ts` now adds that case from the plan in `firestore-real-sibling-merge.ts`: it seeds a companion with `role: 'admin'` and `modified: false`, commits a batch that updates only `modified` beside a create whose rule reads both fields through `getAfter()`, makes the same create alone as a DENY control, and commits a batch that updates both fields of a second companion as an ALLOW control. The writer refuses to record a capture unless both solo controls answer DENY and the two-field batch answers ALLOW. Its next run writes the batch verdict into the observation's `behavior` under the corpus case key, and all three verdicts into `diagnostics.productionDatabase`, which also makes `run-rules.ts` leave the observation alone. `packages/conformance/test/src/firestore-real-sibling-merge.test.ts` runs the same plan through `LocalEnvironment` and compares it with those recorded verdicts. Until the capture lands, the unit-backed assertion in `unit:rules/oracle-conformance.test.ts` pins the local behavior: a batch update keeps the companion's other fields in `getAfter()`.",
  automation: "unit-backed",
  conformanceDisposition: "probe-limitation",
  oracleObservations: ["rules-firestore-atomic-batch-sibling-merge"],
  conformanceTests: [
    "packages/pyric/test/rules/oracle-conformance.test.ts",
    "packages/pyric/test/sandbox/firestore/simulator/get-after-batch.test.ts",
    "packages/conformance/test/src/firestore-real-sibling-merge.test.ts",
  ],
  constructs: ["firestore.function.getAfter"],
});
