import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "Cross-doc `get(/databases/$(database)/documents/...)` in rules works under sandbox; `get()` of a **missing** doc ERRORS (guard with `exists()`), and `get(p).id` / `get(p).__name__` expose the doc identity (RULES-B8)",
  status: "conforms",
  evidence: "`playground:rules-cross-doc-get`, `unit:rules/simulator/evaluator.test.ts` (RULES-B8 block)",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  automation: "unit-backed",
  conformanceTests: ["packages/rules/test/simulator/evaluator.test.ts"],
  exceptionReason: "playground / preview behavior — no firebase-js-sdk counterpart to observe",
});
