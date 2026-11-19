import { row } from './section.ts';

export default row({
  order: 600,
  featureKeys: ["evaluateStorageRules", "request.method", "write"],
  behavior: "A coarse `write` with `request.resource` over a stored object is checked as a `create`, as production checks an upload over an existing object, so an `allow update` grant cannot admit it; `evaluateStorageRules` and CLI/MCP `rules.simulate` agree with the live upload (ST3-C-1)",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "`oracle:stdlib-realstorage-request-resource-fields` records production, under real client uploads of 6 bytes over a stored 5-byte object, ALLOWING `overwrite/verb-create` (`allow create: if true`) and `overwrite/create-stored-and-new-size`, and DENYING `overwrite/verb-update` (`allow update: if true`). Before #1884 `impliedVerbs` bound such a write to `update`, so the evaluator and simulate gave the opposite verdict on all three and predicted ALLOW for a 50 MB overwrite that `allow create` caps. `unit:storage/sandbox/rules-evaluator-semantics.test.ts` replays those probes and the 50 MB case through `evaluateStorageRules`, and `packages/cli/test/bridge/surface/rules-engines/storage.test.ts` runs them through `rules.simulate` over an object stored in the sandbox.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["a simulated overwrite that production denies predicted ALLOW under an `allow update` grant"],
  oracleObservations: ["stdlib-realstorage-request-resource-fields"],
  conformanceTests: [
    "packages/rules/test/storage/sandbox/rules-evaluator-semantics.test.ts",
    "packages/cli/test/bridge/surface/rules-engines/storage.test.ts",
  ],
  constructs: ["storage.binding.request.method", "storage.rule-kind.allow-write"],
});
