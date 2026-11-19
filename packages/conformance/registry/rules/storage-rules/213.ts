import { row } from './section.ts';

export default row({
  order: 510,
  featureKeys: ["String"],
  behavior: "Strings order by UTF-16 code unit, so a character above the BMP sorts before U+FFFF and U+FF5A",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "`oracle:rules-storage-h1-string-ordering` (captured 2026-10-27, 5 cases) records production DENYING the three code-point-order comparisons and ALLOWING the ASCII and map-keys controls. The evaluator agrees on all 5, refuting ST-H1-9. `unit:storage/rules-oracle-conformance.test.ts` replays them with no pin.",
  risk: ["rules-denial"],
  riskScore: 1,
  riskReasons: ["asserts rules-denial behavior"],
  oracleObservations: ["rules-storage-h1-string-ordering"],
  conformanceTests: ["packages/rules/test/storage/rules-oracle-conformance.test.ts"],
});
