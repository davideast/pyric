import { row } from './section.ts';

export default row({
  order: 50,
  behavior: "`resource.data.<field>` (existing doc on writes) works under sandbox; undefined-field reads ERROR (RULES-B2)",
  status: "conforms",
  evidence: "`playground:rules-resource-data-field`, `unit:rules/simulator/evaluator.test.ts` (RULES-B2 block)",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  automation: "unit-backed",
  conformanceTests: ["packages/rules/test/simulator/evaluator.test.ts"],
  exceptionReason: "playground / preview behavior — no firebase-js-sdk counterpart to observe",
});
