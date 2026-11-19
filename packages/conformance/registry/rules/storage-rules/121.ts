import { row } from './section.ts';

export default row({
  order: 210,
  featureKeys: [],
  behavior: "`is` type tests over the storage bindings (`size is int`, `contentType is string`, `metadata is map`, `split() is list`) and int/float LITERAL typing (`1.0 is float`, `1 is int`, cross checks false)",
  status: "conforms",
  evidence: "ROW CORRECTED, 2026-07-17 (same day): the evaluator now adopts the simulator's RULES-B5 float model — a `RulesFloat` wrapper tags float values (a numeric literal written with a decimal point converts to one) while a bare JS number means int — so `1.0 is float` / `!(1.0 is int)` type by literal form exactly as production does. `oracle:rules-storage-type-checks-is` now matches production verdict-for-verdict on all 3 cases with no knownGap abstentions. The prior same-day row recorded the value-typed divergence; that gap is closed.",
  risk: ["rules-denial"],
  riskScore: 1,
  riskReasons: ["asserts rules-denial behavior"],
  automation: "oracle-backed",
  oracleObservations: ["rules-storage-type-checks-is"],
  conformanceTests: ["packages/rules/test/storage/rules-oracle-conformance.test.ts"],
  constructs: ["storage.operator.is"],
});
