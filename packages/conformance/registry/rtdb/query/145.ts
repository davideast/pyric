import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["equalTo"],
  behavior: "`equalTo(v)` filters children whose ordered field === v (returns 0, 1, or multiple matches — RTDB does NOT enforce uniqueness)",
  evidence: "oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-query-equalto.json` — seeded `{red, blue, blue, green}`, observed `matchedKeys: ['k2', 'k3']` for `equalTo('blue')` (both blue children, none of the others). Additional probe: `packages/conformance/observations/rtdb-modular/rtdb-modular-equalTo-filter.json` (a..b..c groups) confirms `equalTo('b')` returns the two `b` children.",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  oracleObservations: ["rtdb-modular-equalTo-filter","rtdb-modular-query-equalto"],
  aliases: ["rtdb#145"],
});
