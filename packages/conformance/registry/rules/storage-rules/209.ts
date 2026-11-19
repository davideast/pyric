import { row } from './section.ts';

export default row({
  order: 470,
  featureKeys: ["in"],
  behavior: "`in` binds looser than `==` and `!=`: `'a' in ['a','b'] == true` reads as `'a' in (['a','b'] == true)` and denies, while the parenthesized form allows",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "`oracle:rules-storage-h1-in-is-precedence` (captured 2026-10-27, 6 cases) records production DENYING the four unparenthesized `in` comparisons and ALLOWING the parenthesized control and a nested ternary. The evaluator agrees on all 6, refuting the evaluation half of ST-H1-5; the documented precedence table is wrong for `in`. `unit:storage/rules-oracle-conformance.test.ts` replays them with no pin.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts rules-denial behavior"],
  oracleObservations: ["rules-storage-h1-in-is-precedence"],
  conformanceTests: ["packages/rules/test/storage/rules-oracle-conformance.test.ts"],
});
