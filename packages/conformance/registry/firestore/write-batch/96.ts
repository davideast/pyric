import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "`batch.commit()` applies all queued writes atomically — success path commits all queued mutations together; failure path (one write violating rules) rejects the **whole** batch with no partial application",
  evidence: "`unit:sandbox-target.test.ts`, oracle: `packages/conformance/observations/firestore/firestore-row-96-batch-commit-atomic.json` — success path: a batch with `set` (fresh doc), `update` (existing doc), and `delete` (existing doc) all land in a single commit (`allApplied: true`). Failure path: a batch with one write targeting a path **outside** `pyric_oracle/*` rejects with `code: 'permission-denied'` and leaves the would-have-set doc absent and the would-have-updated doc at its original value (`noPartialApply: true`) — atomicity verified end-to-end.",
  risk: ["specific-field","sentinel","atomicity","rules-denial"],
  riskScore: 7,
  riskReasons: ["asserts a specific field/property value","asserts sentinel or atomic transform semantics","asserts transaction/batch atomicity","asserts rules-denial behavior"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-row-96-batch-commit-atomic"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts"],
});
