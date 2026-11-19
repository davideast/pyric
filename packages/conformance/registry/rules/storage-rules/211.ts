import { row } from './section.ts';

export default row({
  order: 490,
  featureKeys: ["evaluateStorageRules"],
  behavior: "An unknown method is an evaluation error value, so `'a'.foo() || true` and `!('a'.foo() == 1 && false)` allow (ST-H1-8)",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "`oracle:rules-storage-h1-unknown-method-absorption` (captured 2026-10-27, 4 cases) records production ALLOWING all four absorbed unknown-method cases. The evaluator agrees on all 4: a method no receiver type defines is production's \"Function not found error: Name: [foo].\", an error value `||` and `&&` absorb (`evalMethodCall` in `rules-methods.ts`, #1343). `unit:storage/rules-oracle-conformance.test.ts` replays them with no pin, and `unit:storage/sandbox/rules-evaluator-semantics.test.ts` covers the four cases and the unabsorbed denial.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts rules-denial behavior"],
  oracleObservations: ["rules-storage-h1-unknown-method-absorption"],
  conformanceTests: [
    "packages/rules/test/storage/rules-oracle-conformance.test.ts",
    "packages/rules/test/storage/sandbox/rules-evaluator-semantics.test.ts",
  ],
  constructs: ["storage.operator.or", "storage.operator.and"],
});
