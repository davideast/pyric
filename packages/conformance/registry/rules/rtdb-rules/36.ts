import { row } from './section.ts';

export default row({
  order: 370,
  featureKeys: [],
  behavior: "`query` in a `.write` or `.validate` rule reads as it does on a plain read, so `query.orderByKey` is `false` and `!query.orderByKey` grants (SP-4)",
  evidence: "`oracle:rules-rtdb-r49-value-edges` (captured 2026-10-26) records production ALLOWING a write under `!query.orderByKey` and under `query.orderByKey == false`, and under the control `query.limitToFirst == null`. The simulator gives a write the plain-read `query` (`buildSimulatedQueryContext`), and `unit:rules/rtdb/rules-conformance.test.ts` replays all three verdicts. `unit:rules/rtdb/simulation/handler.test.ts` checks `.write` and `.validate` both read it and that a write ignores a query passed with it. Row #26 records the same fields agreeing on reads. Fixed in #1247 stream S3.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts writes whose rules read query allow and deny as production does"],
  oracleObservations: ["rules-rtdb-r49-value-edges"],
  conformanceTests: ["packages/pyric/test/rules/rtdb/simulation/handler.test.ts"],
  constructs: ["rtdb.binding.query", "rtdb.binding.query.orderByKey"],
});
