import { row } from './section.ts';

export default row({
  order: 100,
  behavior: "Type-strict operators: `+` requires supported operand types (`'a' + 1` and `[1] + [2]` error; `list.concat(list)` joins lists); ordered compares (`< > <= >=`) error across types; list membership uses value equality; `is map` excludes MapDiff/Set (RULES-B6 partial / B9 / B12 partial)",
  status: "conforms",
  evidence: "`unit:rules/simulator/evaluator.test.ts` (RULES-B6 / B9 / B12 blocks)",
  automation: "unit-backed",
  conformanceTests: ["packages/rules/test/simulator/evaluator.test.ts"],
});
