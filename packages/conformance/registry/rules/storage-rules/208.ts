import { row } from './section.ts';

export default row({
  order: 460,
  featureKeys: ["in", "is"],
  behavior: "`in` and `is` chain and compare at parse: `size is int == true`, `(a in list) is bool`, `(a in list) in [true]` and `(1 is int) is bool` compile (ST-H1-5)",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "`oracle:rules-storage-h1-in-is-precedence-deploy` (captured 2026-10-27, 4 cases) records production compiling all four expressions and giving ALLOW, DENY, ALLOW and ALLOW. The shared grammar and evaluator agree on all 4 cases.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["pyric refuses a ruleset production deploys"],
  oracleObservations: ["rules-storage-h1-in-is-precedence-deploy"],
  conformanceTests: ["packages/rules/test/storage/rules-oracle-conformance.test.ts"],
  constructs: ["storage.operator.in", "storage.operator.is"],
});
